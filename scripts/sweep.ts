/**
 * Varredura ampla: sorteia artigos do ns 0, passa pelo filtro de exclusão,
 * coleta as métricas de quem sobrou e grava no pool com score.
 *
 * As etapas estão em ordem de custo. Cada uma só roda sobre quem passou pela
 * anterior, porque a maior parte dos candidatos morre nas regras baratas e
 * não vale pagar wikitext nem audiência por eles.
 *
 * Uso: npm run sweep -- [--n=2000] [--refresh] [--no-pageviews]
 */
import { WIKI_LANG, articleUrl } from "../src/lib/config";
import { WikiClient } from "../src/lib/wiki/client";
import { DiskCache } from "../src/lib/wiki/cache";
import { fetchPageFacts } from "../src/lib/wiki/pages";
import { cleanExtract } from "../src/lib/wiki/extract";
import {
  countRefs,
  countSections,
  fetchBacklinks,
  fetchCountedProps,
  fetchPageviews,
  fetchWikitext,
} from "../src/lib/wiki/metrics";
import { RejectionReport, loadFilters, reject } from "../src/lib/filters";
import { loadScoreConfig, scoreArticle } from "../src/lib/score";
import { type ArticleRecord, finishRun, startRun, upsertArticles } from "../src/lib/db/articles";
import { finalizeDb, openDb } from "../src/lib/db";

const SOURCE = "random";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const skipPageviews = args.includes("--no-pageviews");
const nArg = args.find((a) => a.startsWith("--n="));
const target = nArg ? Number(nArg.split("=")[1]) : 1000;

const progress = (label: string) => (done: number, total: number) => {
  if (done % 200 === 0 || done === total) {
    process.stdout.write(`  ${label}: ${done}/${total}\r`);
  }
};

async function main() {
  const lang = WIKI_LANG;
  console.log(`Varredura ampla — ${lang}.wikipedia.org, alvo ${target} candidatos\n`);

  let network = 0;
  let cached = 0;
  const cache = new DiskCache();
  const client = new WikiClient({
    lang,
    refresh,
    cache,
    onRequest: ({ cached: hit }) => (hit ? cached++ : network++),
  });

  const filters = loadFilters();
  const scoreCfg = loadScoreConfig();
  const report = new RejectionReport();

  // 1. Sorteia títulos do ns 0.
  const titles: string[] = [];
  for await (const body of client.paginate<{
    query?: { random?: Array<{ title: string }> };
  }>({ action: "query", list: "random", rnnamespace: 0, rnlimit: "max" }, 200)) {
    for (const r of body.query?.random ?? []) titles.push(r.title);
    if (titles.length >= target) break;
  }
  const candidates = titles.slice(0, target);
  console.log(`Sorteados: ${candidates.length} títulos\n`);

  // 2. Consulta básica: tamanho, namespace, desambiguação, resumo, imagem.
  console.log("Etapa 1 — dados básicos");
  const facts = await fetchPageFacts(client, candidates, progress("básicos"));
  console.log("");

  // Categorias entram aqui porque vêm no mesmo request das contagens e o
  // filtro de categoria é barato comparado ao wikitext.
  const surviving: string[] = [];
  const notFound: string[] = [];
  for (const title of candidates) {
    const f = facts.get(title);
    if (!f) {
      notFound.push(title);
      continue;
    }
    const r = reject({ title: f.title, ns: f.ns, bytes: f.bytes, isDisambiguation: f.isDisambiguation }, filters);
    if (r) {
      report.record(r);
      continue;
    }
    surviving.push(title);
  }
  console.log(`  sobreviveram às regras baratas: ${surviving.length}\n`);

  // 3. Categorias, langlinks e imagens — um request cobre os três.
  console.log("Etapa 2 — categorias, langlinks e imagens");
  const props = await fetchCountedProps(
    client,
    surviving.map((t) => facts.get(t)!.title),
    progress("props"),
  );
  console.log("");

  const afterCategories: string[] = [];
  for (const title of surviving) {
    const f = facts.get(title)!;
    const r = reject(
      {
        title: f.title,
        ns: f.ns,
        bytes: f.bytes,
        categories: props.categories.get(f.title) ?? [],
      },
      filters,
    );
    if (r) {
      report.record(r);
      continue;
    }
    afterCategories.push(title);
  }
  console.log(`  sobreviveram às categorias: ${afterCategories.length}\n`);

  // 4. Wikitext: esboço, prosa, refs e seções.
  console.log("Etapa 3 — wikitext");
  const wikitexts = await fetchWikitext(
    client,
    afterCategories.map((t) => facts.get(t)!.title),
    progress("wikitext"),
  );
  console.log("");

  const passed: string[] = [];
  for (const title of afterCategories) {
    const f = facts.get(title)!;
    const wikitext = wikitexts.get(f.title);
    const r = reject(
      {
        title: f.title,
        ns: f.ns,
        bytes: f.bytes,
        categories: props.categories.get(f.title) ?? [],
        wikitext,
      },
      filters,
    );
    if (r) {
      report.record(r);
      continue;
    }
    report.record(undefined);
    passed.push(title);
  }
  console.log(`  aprovados: ${passed.length}\n`);

  if (passed.length === 0) {
    console.log("Nenhum candidato passou pelo filtro. Nada a gravar.");
    return;
  }

  // 5. Backlinks: um request por artigo, só para quem passou.
  console.log("Etapa 4 — backlinks");
  const backlinks = await fetchBacklinks(
    client,
    passed.map((t) => facts.get(t)!.title),
    undefined,
    progress("backlinks"),
  );
  console.log("");

  // 6. Audiência: a chamada mais cara, e a última.
  const pageviews = new Map<string, number>();
  if (!skipPageviews) {
    console.log("Etapa 5 — audiência");
    let done = 0;
    for (const title of passed) {
      const real = facts.get(title)!.title;
      const v = await fetchPageviews(lang, real, 12, cache);
      if (v !== undefined) pageviews.set(real, v);
      done++;
      if (done % 50 === 0 || done === passed.length) {
        process.stdout.write(`  audiência: ${done}/${passed.length}\r`);
      }
    }
    console.log("\n");
  } else {
    console.log("Audiência pulada por --no-pageviews\n");
  }

  // 7. Score e gravação.
  const db = openDb();
  const runId = startRun(db, lang, SOURCE);

  const rows: ArticleRecord[] = [];
  for (const title of passed) {
    const f = facts.get(title)!;
    const wikitext = wikitexts.get(f.title) ?? "";
    const metrics = {
      bytes: f.bytes,
      langlinks: props.langlinks.get(f.title) ?? 0,
      images: props.images.get(f.title) ?? 0,
      backlinks: backlinks.get(f.title) ?? 0,
      refs: countRefs(wikitext),
      sections: countSections(wikitext),
      pageviews: pageviews.get(f.title),
    };
    const { quality, surprise } = scoreArticle(metrics, scoreCfg, { curated: false });

    rows.push({
      lang,
      pageId: f.pageId,
      title: f.title,
      url: f.url ?? articleUrl(f.title, lang),
      extract: f.extract ? cleanExtract(f.extract) : undefined,
      thumbnailUrl: f.thumbnailUrl,
      ...metrics,
      scoreQuality: quality,
      scoreSurprise: surprise,
      source: SOURCE,
      curated: false,
    });
  }

  const written = upsertArticles(db, rows);
  finishRun(db, runId, {
    found: candidates.length,
    written,
    skipped: candidates.length - written,
    notes: JSON.stringify(Object.fromEntries(report.summary.byRule)),
  });

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  finalizeDb(db);

  console.log("Descartes por regra");
  console.log(report.format());
  console.log(`\n  não encontrados (redirect quebrado, apagados): ${notFound.length}`);
  console.log(`\nGravados: ${written}`);
  console.log(`Pool total (${lang}): ${total.n} artigos`);
  console.log(`Requests: ${network} de rede, ${cached} do cache`);
}

main().catch((err) => {
  console.error(`\nFALHA NA VARREDURA\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
