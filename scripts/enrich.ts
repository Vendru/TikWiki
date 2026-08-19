/**
 * Coleta as métricas que faltam e recalcula os scores do pool inteiro.
 *
 * Separado da ingestão de propósito: as fontes trazem os artigos, este script
 * os mede. Assim dá para recalibrar os pesos em config/score.json e repontuar
 * tudo com `--score-only`, sem tocar na rede.
 *
 * Uso: npm run enrich -- [--limit=N] [--score-only] [--no-pageviews] [--refresh]
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
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

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

const progress = (label: string) => (done: number, total: number) => {
  if (done % 100 === 0 || done === total) {
    process.stdout.write(`  ${label}: ${done}/${total}\r`);
  }
};

async function main() {
  const lang = WIKI_LANG;
  const db = openDb();
  const scoreCfg = loadScoreConfig();

  // Sem --limit, mede quem ainda não tem métrica; com ele, uma amostra.
  const where = scoreOnly ? "1=1" : "backlinks IS NULL";
  const rows = db
    .prepare(
      `SELECT page_id, title, bytes, langlinks, backlinks, refs, images,
              sections, pageviews, curated
         FROM articles WHERE lang = ? AND ${where}
         ORDER BY curated DESC, page_id
         ${limit ? `LIMIT ${Number(limit)}` : ""}`,
    )
    .all(lang) as Row[];

  console.log(
    `${scoreOnly ? "Repontuando" : "Enriquecendo"} ${rows.length} artigos — ${lang}\n`,
  );
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

  const titles = rows.map((r) => r.title);
  const measured = new Map<string, Partial<Row>>();

  if (!scoreOnly) {
    console.log("Langlinks e imagens");
    const props = await fetchCountedProps(client, titles, progress("props"));
    console.log("\n\nWikitext (refs e seções)");
    const wikitexts = await fetchWikitext(client, titles, progress("wikitext"));
    console.log("\n\nBacklinks");
    const backlinks = await fetchBacklinks(client, titles, 500, progress("backlinks"));
    console.log("");

    const views = new Map<string, number>();
    if (!skipPageviews) {
      console.log("\nAudiência");
      let done = 0;
      for (const title of titles) {
        const v = await fetchPageviews(lang, title, 12, cache);
        if (v !== undefined) views.set(title, v);
        done++;
        if (done % 100 === 0 || done === titles.length) {
          process.stdout.write(`  audiência: ${done}/${titles.length}\r`);
        }
      }
      console.log("");
    }

    for (const title of titles) {
      const wikitext = wikitexts.get(title) ?? "";
      measured.set(title, {
        langlinks: props.langlinks.get(title) ?? 0,
        images: props.images.get(title) ?? 0,
        backlinks: backlinks.get(title) ?? 0,
        refs: wikitext ? countRefs(wikitext) : null,
        sections: wikitext ? countSections(wikitext) : null,
        pageviews: views.get(title) ?? null,
      });
    }
  }

  const update = db.prepare(
    `UPDATE articles
        SET langlinks = @langlinks, backlinks = @backlinks, refs = @refs,
            images = @images, sections = @sections, pageviews = @pageviews,
            score_quality = @quality, score_surprise = @surprise,
            updated_at = @updatedAt
      WHERE lang = @lang AND page_id = @pageId`,
  );

  const updatedAt = new Date().toISOString();
  const run = db.transaction((batch: Row[]) => {
    for (const r of batch) {
      const m = measured.get(r.title) ?? {};
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
      update.run({
        ...metrics,
        quality,
        surprise,
        lang,
        pageId: r.page_id,
        updatedAt,
      });
    }
  });
  run(rows);

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
}

main().catch((err) => {
  console.error(`\nFALHA NO ENRIQUECIMENTO\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
