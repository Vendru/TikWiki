/**
 * Ingestão do arquivo do "Você sabia?".
 *
 * Uso: npm run ingest:dyk [-- --refresh] [-- --limit=N]
 *
 * A escala aqui é outra: são mais de cem mil ganchos contra os quatro mil da
 * lista peculiar. Por isso a gravação é incremental — uma interrupção no meio
 * de uma corrida longa não pode custar tudo que já foi buscado.
 */
import { WIKI_LANG, articleUrl } from "../src/lib/config";
import { WikiClient } from "../src/lib/wiki/client";
import { fetchPageFacts } from "../src/lib/wiki/pages";
import { cleanExtract } from "../src/lib/wiki/extract";
import {
  SOURCE,
  discoverArchives,
  loadConfig,
  parseDykHooks,
} from "../src/lib/sources/dyk";
import { type ArticleRecord, finishRun, startRun, upsertArticles } from "../src/lib/db/articles";
import { finalizeDb, openDb } from "../src/lib/db";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

/** Títulos por rodada de gravação. */
const CHECKPOINT = 2000;

async function main() {
  const lang = WIKI_LANG;
  console.log(`Ingestão '${SOURCE}' — ${lang}.wikipedia.org\n`);

  let network = 0;
  let cached = 0;
  const client = new WikiClient({
    lang,
    refresh,
    onRequest: ({ cached: hit }) => (hit ? cached++ : network++),
  });

  const cfg = loadConfig(lang);
  const arquivos = await discoverArchives(client, cfg);
  console.log(`Arquivos encontrados: ${arquivos.length}`);

  // Lê os arquivos em lote e junta os ganchos, deduplicando por título.
  // A chave é minúscula só para deduplicar: o título consultado precisa da
  // capitalização original, porque o MediaWiki só normaliza a primeira letra.
  const ganchos = new Map<string, { title: string; hook: string }>();
  let lidos = 0;
  for (const lote of WikiClient.batchTitles(arquivos, 20)) {
    const body = await client.get<{
      query?: {
        pages?: Array<{
          title: string;
          revisions?: Array<{ slots?: { main?: { content?: string } } }>;
        }>;
      };
    }>({
      action: "query",
      titles: lote.join("|"),
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
    });

    for (const page of body.query?.pages ?? []) {
      const wikitext = page.revisions?.[0]?.slots?.main?.content;
      if (!wikitext) continue;
      for (const h of parseDykHooks(wikitext)) {
        // Um artigo pode reaparecer em outro gancho; fica o primeiro.
        const chave = h.title.toLowerCase();
        if (!ganchos.has(chave)) ganchos.set(chave, h);
      }
    }
    lidos += lote.length;
    process.stdout.write(`  arquivos lidos: ${lidos}/${arquivos.length}\r`);
  }
  console.log("");

  const entradas = [...ganchos.entries()].map(([chave, { title, hook }]) => ({
    chave,
    title,
    hook,
  }));
  console.log(`Ganchos únicos: ${entradas.length}`);

  const selecionadas = limit ? entradas.slice(0, limit) : entradas;
  if (limit) console.log(`Limitado a ${selecionadas.length} por --limit`);

  const db = openDb();
  const runId = startRun(db, lang, SOURCE);

  // Já no pool: um artigo que veio da lista peculiar não é rebaixado, e o
  // upsert preserva a fonte curada, mas pular economiza rede.
  const existentes = new Set(
    (db.prepare(`SELECT LOWER(title) t FROM articles WHERE lang = ?`).all(lang) as {
      t: string;
    }[]).map((r) => r.t),
  );
  const pendentes = selecionadas.filter((e) => !existentes.has(e.chave));
  console.log(`Já no pool: ${selecionadas.length - pendentes.length}`);
  console.log(`A buscar: ${pendentes.length}\n`);

  const descartes = { inexistente: 0, namespace: 0, desambiguacao: 0, duplicado: 0 };
  const pageIdsVistos = new Set<number>();
  let gravados = 0;
  let processados = 0;
  let pendenteLote: ArticleRecord[] = [];

  const gravar = () => {
    if (pendenteLote.length === 0) return;
    gravados += upsertArticles(db, pendenteLote);
    pendenteLote = [];
  };

  // Índice por título, para achar o gancho sem varrer a lista a cada fatia.
  const porTitulo = new Map(pendentes.map((e) => [e.title, e.hook]));

  for (const fatia of WikiClient.batchTitles(
    pendentes.map((e) => e.title),
    CHECKPOINT,
  )) {
    const facts = await fetchPageFacts(client, fatia);

    for (const titulo of fatia) {
      const f = facts.get(titulo);
      if (!f) {
        descartes.inexistente++;
        continue;
      }
      if (f.ns !== 0) {
        descartes.namespace++;
        continue;
      }
      if (f.isDisambiguation) {
        descartes.desambiguacao++;
        continue;
      }
      if (pageIdsVistos.has(f.pageId)) {
        descartes.duplicado++;
        continue;
      }
      pageIdsVistos.add(f.pageId);

      pendenteLote.push({
        lang,
        pageId: f.pageId,
        title: f.title,
        url: f.url ?? articleUrl(f.title, lang),
        extract: f.extract ? cleanExtract(f.extract) : undefined,
        thumbnailUrl: f.thumbnailUrl,
        curatorNote: porTitulo.get(titulo),
        bytes: f.bytes,
        source: SOURCE,
        curated: true,
      });
    }

    // Ponto de checagem: o que já foi medido fica salvo.
    gravar();
    processados += fatia.length;
    process.stdout.write(
      `  processados ${processados}/${pendentes.length} — gravados ${gravados}\r`,
    );
  }
  gravar();
  console.log("\n");

  finishRun(db, runId, {
    found: selecionadas.length,
    written: gravados,
    skipped: selecionadas.length - gravados,
    notes: JSON.stringify(descartes),
  });

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  const porFonte = db
    .prepare(
      `SELECT source, COUNT(*) n FROM articles WHERE lang = ? GROUP BY source ORDER BY n DESC`,
    )
    .all(lang) as { source: string; n: number }[];
  finalizeDb(db);

  console.log(`Gravados:    ${gravados}`);
  console.log(`Descartados: ${JSON.stringify(descartes)}`);
  console.log(`\nPool total (${lang}): ${total.n}`);
  for (const f of porFonte) console.log(`  ${f.source.padEnd(9)} ${f.n}`);
  console.log(`Requests: ${network} de rede, ${cached} do cache`);
}

main().catch((err) => {
  console.error(`\nFALHA NA INGESTÃO\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
