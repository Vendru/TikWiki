/**
 * Coleta as métricas que faltam e recalcula os scores do pool.
 *
 * Separado da ingestão de propósito: as fontes trazem os artigos, este script
 * os mede. Assim dá para recalibrar os pesos em config/score.json e repontuar
 * tudo com `--score-only`, sem tocar na rede.
 *
 * O trabalho é feito em blocos: com o pool na casa das centenas de milhares,
 * guardar o wikitext de todo mundo em memória antes de gravar consumiria
 * gigabytes, e uma interrupção custaria tudo que já foi buscado.
 *
 * Uso: npm run enrich -- [opções]
 *   --no-backlinks   pula backlinks (1 request por artigo)
 *   --no-pageviews   pula audiência (1 request por artigo, e é outra API)
 *   --top=N          mede os N melhores pelo score que já existe
 *   --limit=N        processa só os N primeiros, para validar rápido
 *   --score-only     repontua sem tocar na rede
 *   --refresh        ignora o cache de leitura
 *
 * Combinar --no-backlinks com --no-pageviews mede só o que vem em lote, ao
 * custo de cerca de 0,07 request por artigo em vez de 2,07 — a diferença
 * entre medir o pool inteiro e esbarrar no limite de taxa da API.
 */
import { WIKI_LANG } from "../src/lib/config";
import { WikiClient } from "../src/lib/wiki/client";
import { DiskCache } from "../src/lib/wiki/cache";
import {
  countRefs,
  countSections,
  fetchBacklinks,
  fetchCountedProps,
  fetchPageviews,
  fetchWikitext,
} from "../src/lib/wiki/metrics";
import { loadScoreConfig, scoreArticle } from "../src/lib/score";
import { finalizeDb, openDb } from "../src/lib/db";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const scoreOnly = args.includes("--score-only");
const skipPageviews = args.includes("--no-pageviews");
const skipBacklinks = args.includes("--no-backlinks");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
const topArg = args.find((a) => a.startsWith("--top="));
const top = topArg ? Number(topArg.split("=")[1]) : undefined;

/**
 * Backlinks e audiência custam um request por artigo; as demais métricas vêm
 * em lotes de 20 a 50. Numa wiki grande essa diferença é de duas ordens de
 * grandeza, e a API impõe limite de taxa muito antes de a corrida completa
 * terminar. Daí as duas travas: dá para medir só o que é agrupável no pool
 * inteiro, e depois completar os melhores.
 */
const custoPorArtigo = (skipBacklinks ? 0 : 1) + (skipPageviews ? 0 : 1) + 0.07;

/** Artigos medidos e gravados por bloco. */
const BLOCO = 500;

interface Row {
  page_id: number;
  title: string;
  bytes: number | null;
  langlinks: number | null;
  backlinks: number | null;
  refs: number | null;
  images: number | null;
  sections: number | null;
  pageviews: number | null;
  curated: number;
}

function fmtDuracao(ms: number): string {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`;
}

async function main() {
  const lang = WIKI_LANG;
  const db = openDb();
  const scoreCfg = loadScoreConfig();

  // Seleciona quem está faltando exatamente aquilo que esta corrida vai
  // buscar — pedir por métrica que não será medida faria o trabalho girar em
  // falso a cada execução. Audiência ausente entra na conta: pode ser artigo
  // sem histórico, mas o cache guarda também esse "sem dado", e a chave do
  // cache inclui o mês, que é o que faz o número envelhecer com a realidade.
  const faltando = ["langlinks IS NULL", "refs IS NULL"];
  if (!skipBacklinks) faltando.push("backlinks IS NULL");
  if (!skipPageviews) faltando.push("pageviews IS NULL");
  const where = scoreOnly ? "1=1" : faltando.join(" OR ");

  // Com --top, mede primeiro os melhores pelo score que já existe. É como a
  // segunda etapa escolhe onde gastar o request por artigo.
  const ordem = top
    ? "score_quality DESC NULLS LAST, curated DESC"
    : "curated DESC, page_id";
  const teto = top ?? limit;

  const rows = db
    .prepare(
      `SELECT page_id, title, bytes, langlinks, backlinks, refs, images,
              sections, pageviews, curated
         FROM articles WHERE lang = ? AND ${where}
         ORDER BY ${ordem}
         ${teto ? `LIMIT ${Number(teto)}` : ""}`,
    )
    .all(lang) as Row[];

  console.log(
    `${scoreOnly ? "Repontuando" : "Enriquecendo"} ${rows.length} artigos — ${lang}`,
  );
  if (!scoreOnly) {
    const medidas = ["langlinks", "imagens", "refs", "seções"];
    if (!skipBacklinks) medidas.push("backlinks");
    if (!skipPageviews) medidas.push("audiência");
    console.log(`Métricas: ${medidas.join(", ")}`);
    console.log(
      `Custo estimado: ~${Math.round(rows.length * custoPorArtigo).toLocaleString("pt-BR")} requests`,
    );
  }
  console.log("");
  if (rows.length === 0) {
    console.log("Nada a fazer.");
    finalizeDb(db);
    return;
  }

  let network = 0;
  let cached = 0;
  const cache = new DiskCache();
  const client = new WikiClient({
    lang,
    refresh,
    cache,
    onRequest: ({ cached: hit }) => (hit ? cached++ : network++),
  });

  const update = db.prepare(
    `UPDATE articles
        SET langlinks = @langlinks, backlinks = @backlinks, refs = @refs,
            images = @images, sections = @sections, pageviews = @pageviews,
            score_quality = @quality, score_surprise = @surprise,
            updated_at = @updatedAt
      WHERE lang = @lang AND page_id = @pageId`,
  );

  const gravarBloco = db.transaction(
    (bloco: Row[], medidas: Map<string, Partial<Row>>) => {
      const updatedAt = new Date().toISOString();
      for (const r of bloco) {
        const m = medidas.get(r.title) ?? {};
        const metrics = {
          bytes: r.bytes,
          langlinks: m.langlinks ?? r.langlinks,
          backlinks: m.backlinks ?? r.backlinks,
          refs: m.refs ?? r.refs,
          sections: m.sections ?? r.sections,
          images: m.images ?? r.images,
          pageviews: m.pageviews ?? r.pageviews,
        };
        const { quality, surprise } = scoreArticle(metrics, scoreCfg, {
          curated: r.curated === 1,
        });
        update.run({ ...metrics, quality, surprise, lang, pageId: r.page_id, updatedAt });
      }
    },
  );

  const inicio = Date.now();
  let feitos = 0;

  for (let i = 0; i < rows.length; i += BLOCO) {
    const bloco = rows.slice(i, i + BLOCO);
    const titulos = bloco.map((r) => r.title);
    const medidas = new Map<string, Partial<Row>>();

    if (!scoreOnly) {
      const props = await fetchCountedProps(client, titulos);
      const wikitexts = await fetchWikitext(client, titulos);

      const backlinks = skipBacklinks
        ? new Map<string, number>()
        : await fetchBacklinks(client, titulos);

      const views = new Map<string, number>();
      if (!skipPageviews) {
        for (const t of titulos) {
          const v = await fetchPageviews(lang, t, 12, cache);
          if (v !== undefined) views.set(t, v);
        }
      }

      for (const t of titulos) {
        const w = wikitexts.get(t);
        medidas.set(t, {
          langlinks: props.langlinks.get(t) ?? 0,
          images: props.images.get(t) ?? 0,
          // Não medido fica nulo, e não zero: o score desconta o peso da
          // métrica ausente em vez de tratá-la como "não tem nenhum".
          backlinks: skipBacklinks ? null : (backlinks.get(t) ?? 0),
          refs: w ? countRefs(w) : null,
          sections: w ? countSections(w) : null,
          pageviews: views.get(t) ?? null,
        });
      }
      // O wikitext do bloco sai de escopo aqui, e é o que mantém a memória
      // constante ao longo de uma corrida de centenas de milhares.
    }

    gravarBloco(bloco, medidas);
    feitos += bloco.length;

    const decorrido = Date.now() - inicio;
    const restante = (decorrido / feitos) * (rows.length - feitos);
    process.stdout.write(
      `  ${feitos}/${rows.length} — faltam ~${fmtDuracao(restante)}          \r`,
    );
  }
  console.log("");

  const stats = db
    .prepare(
      `SELECT COUNT(*) n,
              ROUND(MIN(score_quality),1) qmin, ROUND(AVG(score_quality),1) qavg,
              ROUND(MAX(score_quality),1) qmax,
              ROUND(MIN(score_surprise),1) smin, ROUND(MAX(score_surprise),1) smax
         FROM articles WHERE lang = ? AND score_quality IS NOT NULL`,
    )
    .get(lang) as Record<string, number>;
  finalizeDb(db);

  console.log(`\nPontuados: ${stats.n}`);
  console.log(`  qualidade: ${stats.qmin} … ${stats.qavg} … ${stats.qmax}`);
  console.log(`  surpresa:  ${stats.smin} … ${stats.smax}`);
  console.log(`Requests: ${network} de rede, ${cached} do cache`);
  console.log(`Tempo: ${fmtDuracao(Date.now() - inicio)}`);
}

main().catch((err) => {
  console.error(`\nFALHA NO ENRIQUECIMENTO\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
