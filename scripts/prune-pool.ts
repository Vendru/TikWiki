/**
 * Remove do pool os artigos que as regras atuais reprovariam.
 *
 * As regras evoluem, e reingerir cento e vinte mil artigos para aplicar uma
 * regra nova seria desperdício quando título e tamanho já estão no banco.
 * Roda só as regras que não dependem de categoria nem de wikitext, que são o
 * que o pool guarda.
 *
 * Uso: npm run prune [-- --dry-run] [-- --source=dyk]
 */
import { WIKI_LANG } from "../src/lib/config";
import { loadFilters, reject } from "../src/lib/filters";
import { finalizeDb, openDb } from "../src/lib/db";

const args = process.argv.slice(2);
const seco = args.includes("--dry-run");
const fonteArg = args.find((a) => a.startsWith("--source="));
const fonte = fonteArg?.split("=")[1];

interface Row {
  page_id: number;
  title: string;
  bytes: number | null;
  source: string;
  curated: number;
}

const db = openDb();
const filtros = loadFilters();

const linhas = db
  .prepare(
    `SELECT page_id, title, bytes, source, curated FROM articles
      WHERE lang = ?${fonte ? " AND source = ?" : ""}`,
  )
  .all(...(fonte ? [WIKI_LANG, fonte] : [WIKI_LANG])) as Row[];

const porRegra = new Map<string, string[]>();
const remover: number[] = [];

for (const r of linhas) {
  const v = reject(
    { title: r.title, ns: 0, bytes: r.bytes ?? 0 },
    filtros,
    { curated: r.curated === 1, source: r.source },
  );
  if (!v) continue;
  (porRegra.get(v) ?? porRegra.set(v, []).get(v)!).push(r.title);
  remover.push(r.page_id);
}

console.log(`Examinados: ${linhas.length}${fonte ? ` (fonte ${fonte})` : ""}`);
console.log(`${seco ? "Seriam removidos" : "Removidos"}: ${remover.length}\n`);

for (const [regra, titulos] of [...porRegra.entries()].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.log(`  ${regra.padEnd(26)} ${String(titulos.length).padStart(5)}`);
  console.log(`      ${titulos.slice(0, 3).join(" | ").slice(0, 100)}`);
}

if (!seco && remover.length > 0) {
  const del = db.prepare(`DELETE FROM articles WHERE lang = ? AND page_id = ?`);
  const aplicar = db.transaction((ids: number[]) => {
    for (const id of ids) del.run(WIKI_LANG, id);
  });
  aplicar(remover);

  const restante = db
    .prepare(`SELECT COUNT(*) n FROM articles WHERE lang = ?`)
    .get(WIKI_LANG) as { n: number };
  console.log(`\nPool restante: ${restante.n}`);
}

if (seco) db.close();
else finalizeDb(db);
