/**
 * Amostra o pool para julgamento à mão.
 *
 * Nenhuma métrica sabe o que é curioso — está medido e registrado no README —
 * então a única aferição honesta da qualidade do pool é ler uma amostra. Este
 * script existe para isso: imprime o que o card mostraria, com os scores ao
 * lado, no mesmo formato para qualquer fatia do pool.
 *
 * Uso: npm run sample [-- --n=30] [-- --source=dyk] [-- --mode=surprise]
 *   --n=N          quantos artigos (padrão 30)
 *   --source=X     só de uma fonte: unusual, dyk, random
 *   --mode=M       uniform (padrão), quality ou surprise — o sorteio que o
 *                  app faria em cada modo, para julgar o que o usuário veria
 *   --seed=N       repete a mesma amostra, para comparar antes e depois
 */
import { WIKI_LANG } from "../src/lib/config";
import { openDb } from "../src/lib/db";

const args = process.argv.slice(2);
const valor = (nome: string) =>
  args.find((a) => a.startsWith(`--${nome}=`))?.split("=")[1];

const n = Number(valor("n") ?? 30);
const source = valor("source");
const mode = valor("mode") ?? "uniform";
const seed = valor("seed");

if (!["uniform", "quality", "surprise"].includes(mode)) {
  console.error(`--mode precisa ser uniform, quality ou surprise`);
  process.exit(1);
}

const db = openDb({ readonly: true });

// Em quality e surprise, o peso é o score; em uniform, todos valem o mesmo.
// Em surprise só entram os que têm o dado: sem audiência não há surpresa a
// afirmar, e tratar o nulo como zero inverteria o ranking.
const ordem = {
  uniform: seed ? `substr(page_id * ${Number(seed)}, -6)` : "RANDOM()",
  quality: "score_quality DESC",
  surprise: "score_surprise DESC",
}[mode];

const onde = [
  "lang = ?",
  source ? "source = ?" : null,
  mode === "surprise" ? "score_surprise IS NOT NULL" : null,
]
  .filter(Boolean)
  .join(" AND ");

const linhas = db
  .prepare(
    `SELECT title, curator_note, extract, source, thumbnail_url,
            ROUND(score_quality, 1) q, ROUND(score_surprise, 1) s, ROUND(pageviews) pv
       FROM articles WHERE ${onde} ORDER BY ${ordem} LIMIT ${Number(n)}`,
  )
  .all(...(source ? [WIKI_LANG, source] : [WIKI_LANG])) as Array<{
  title: string;
  curator_note: string | null;
  extract: string | null;
  source: string;
  thumbnail_url: string | null;
  q: number | null;
  s: number | null;
  pv: number | null;
}>;

const total = db
  .prepare(`SELECT COUNT(*) c FROM articles WHERE ${onde}`)
  .get(...(source ? [WIKI_LANG, source] : [WIKI_LANG])) as { c: number };

console.log(
  `Amostra de ${linhas.length} — modo ${mode}${source ? `, fonte ${source}` : ""}, ` +
    `de ${total.c.toLocaleString("pt-BR")} elegíveis\n`,
);

let i = 0;
for (const r of linhas) {
  const scores = [
    `q=${r.q ?? "—"}`,
    `s=${r.s ?? "—"}`,
    r.pv !== null ? `${r.pv} views/mês` : "sem audiência",
    r.thumbnail_url ? "com imagem" : "sem imagem",
  ].join("  ");

  console.log(`${String(++i).padStart(3)}. ${r.title}   [${r.source}]`);
  console.log(`     ${scores}`);
  if (r.curator_note) console.log(`     ${r.curator_note}`);
  if (r.extract) console.log(`     ${r.extract.slice(0, 150)}…`);
  console.log("");
}

db.close();
