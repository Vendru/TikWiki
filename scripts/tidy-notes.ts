/**
 * Reaplica a limpeza às notas já gravadas.
 *
 * As regras de limpeza evoluem conforme aparecem formas novas de entulho, e
 * reingerir o pool inteiro só para corrigir texto seria desperdício: a nota já
 * está no banco, e a limpeza é uma função pura sobre ela.
 *
 * Uso: npm run tidy:notes [-- --dry-run]
 */
import { tidyNote } from "../src/lib/wiki/wikitext";
import { finalizeDb, openDb } from "../src/lib/db";

const seco = process.argv.includes("--dry-run");

const db = openDb();
const linhas = db
  .prepare(
    `SELECT lang, page_id, title, curator_note FROM articles WHERE curator_note IS NOT NULL`,
  )
  .all() as { lang: string; page_id: number; title: string; curator_note: string }[];

const update = db.prepare(
  `UPDATE articles SET curator_note = ? WHERE lang = ? AND page_id = ?`,
);

const mudancas: Array<{ title: string; de: string; para: string }> = [];
const aplicar = db.transaction(() => {
  for (const r of linhas) {
    const limpo = tidyNote(r.curator_note);
    if (limpo === r.curator_note) continue;
    mudancas.push({ title: r.title, de: r.curator_note, para: limpo });
    if (!seco) update.run(limpo || null, r.lang, r.page_id);
  }
});
aplicar();

console.log(`Notas examinadas: ${linhas.length}`);
console.log(`${seco ? "Mudariam" : "Atualizadas"}: ${mudancas.length}`);
for (const m of mudancas.slice(0, 5)) {
  console.log(`\n  ${m.title}`);
  console.log(`    antes: ${m.de.slice(0, 80)}`);
  console.log(`    agora: ${m.para.slice(0, 80)}`);
}

if (seco) db.close();
else finalizeDb(db);
