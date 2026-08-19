/**
 * Ingestão da lista curada de "Artigos peculiares".
 *
 * Uso: npm run ingest:unusual [-- --refresh] [-- --limit=N]
 *   --refresh  ignora o cache em disco e refaz os requests
 *   --limit=N  processa apenas os N primeiros títulos (para validar rápido)
 */
import { WIKI_LANG, articleUrl } from "../src/lib/config";
import { WikiClient } from "../src/lib/wiki/client";
import { fetchPageFacts } from "../src/lib/wiki/pages";
import {
  SOURCE,
  collectEntries,
  discoverSubpages,
  loadConfig,
  resolveHub,
} from "../src/lib/sources/unusual";
import { type ArticleRecord, finishRun, startRun, upsertArticles } from "../src/lib/db/articles";
import { finalizeDb, openDb } from "../src/lib/db";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;

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
  const hub = await resolveHub(client, cfg);
  console.log(`Índice: ${hub.title} (ns ${hub.ns})`);

  const subpages = await discoverSubpages(client, hub, cfg);
  console.log(`Subpáginas consideradas: ${subpages.length}`);
  if (cfg.excludeSubpages.length) {
    console.log(`Excluídas por config: ${cfg.excludeSubpages.join(", ")}`);
  }

  const { entries, perSubpage } = await collectEntries(client, subpages);
  console.log("");
  for (const s of perSubpage) {
    const name = s.subpage.replace(`${hub.title}/`, "");
    if (s.redirect) console.log(`  ${"—".padStart(5)}  ${name} (redirect → ${s.redirect})`);
    else console.log(`  ${String(s.count).padStart(5)}  ${name}`);
  }

  const withNote = [...entries.values()].filter((e) => e.note).length;
  console.log(
    `\nEntradas únicas: ${entries.size} (${withNote} com nota do curador)`,
  );

  const collected = [...entries.values()];
  const selected = limit ? collected.slice(0, limit) : collected;
  if (limit) console.log(`Limitado a ${selected.length} títulos por --limit`);

  const db = openDb();
  const runId = startRun(db, lang, SOURCE);

  console.log(`\nBuscando metadados…`);
  const facts = await fetchPageFacts(
    client,
    selected.map((e) => e.title),
    (done, total) => {
      if (done % 500 === 0 || done === total) {
        process.stdout.write(`  ${done}/${total}\r`);
      }
    },
  );
  console.log(`\n`);

  const rows: ArticleRecord[] = [];
  const dropped = { missing: 0, namespace: 0, disambiguation: 0 };
  const seenPageIds = new Set<number>();

  for (const entry of selected) {
    const f = facts.get(entry.title);
    if (!f) {
      dropped.missing++;
      continue;
    }
    // Entradas curadas pulam o filtro de qualidade, mas estas três exclusões
    // são estruturais: a página não é um artigo.
    if (f.ns !== 0) {
      dropped.namespace++;
      continue;
    }
    if (f.isDisambiguation) {
      dropped.disambiguation++;
      continue;
    }
    // Dois títulos da lista podem redirecionar para o mesmo artigo.
    if (seenPageIds.has(f.pageId)) continue;
    seenPageIds.add(f.pageId);

    rows.push({
      lang,
      pageId: f.pageId,
      title: f.title,
      url: f.url ?? articleUrl(f.title, lang),
      extract: f.extract,
      thumbnailUrl: f.thumbnailUrl,
      curatorNote: entry.note,
      bytes: f.bytes,
      source: SOURCE,
      sourceDetail: entry.subpage,
      curated: true,
    });
  }

  const written = upsertArticles(db, rows);
  const skipped = selected.length - rows.length;
  finishRun(db, runId, {
    found: selected.length,
    written,
    skipped,
    notes: JSON.stringify(dropped),
  });

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  const withThumb = db
    .prepare(
      `SELECT COUNT(*) AS n FROM articles WHERE lang = ? AND thumbnail_url IS NOT NULL`,
    )
    .get(lang) as { n: number };
  finalizeDb(db);

  console.log(`Gravados:      ${written}`);
  console.log(`Descartados:   ${skipped}`);
  console.log(`  inexistentes:   ${dropped.missing}`);
  console.log(`  fora do ns 0:   ${dropped.namespace}`);
  console.log(`  desambiguação:  ${dropped.disambiguation}`);
  console.log(`\nPool total (${lang}): ${total.n} artigos, ${withThumb.n} com imagem`);
  console.log(`Requests: ${network} de rede, ${cached} do cache`);
}

main().catch((err) => {
  console.error(`\nFALHA NA INGESTÃO\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
