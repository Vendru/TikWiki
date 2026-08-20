/**
 * Preenche a tabela de temas, sem tocar na rede.
 *
 * O tema vem de duas origens, e a diferença fica registrada em
 * article_topics.score: 1 para o que foi atribuído à mão, 0.5 para o que foi
 * inferido do resumo. A lista de Artigos peculiares traz a atribuição humana
 * de graça, porque cada entrada mora numa subpágina temática; para as demais
 * fontes o resumo quase sempre diz o que a coisa é na primeira frase.
 *
 * Uso: npm run topics [-- --dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, WIKI_LANG } from "../src/lib/config";
import { finalizeDb, openDb } from "../src/lib/db";

const seco = process.argv.includes("--dry-run");

interface Tema {
  slug: string;
  label: string;
  subpagina: string;
  resumo: string[];
}

const { temas } = JSON.parse(
  fs.readFileSync(path.join(CONFIG_DIR, "topics.json"), "utf8"),
) as { temas: Tema[] };

const compilados = temas.map((t) => ({
  ...t,
  padroes: t.resumo.map((p) => new RegExp(p, "i")),
}));

const db = openDb();

interface Row {
  page_id: number;
  title: string;
  extract: string | null;
  source: string;
  source_detail: string | null;
}

const linhas = db
  .prepare(
    `SELECT page_id, title, extract, source, source_detail
       FROM articles WHERE lang = ?`,
  )
  .all(WIKI_LANG) as Row[];

// Índice das subpáginas curadas, para achar o tema pelo sufixo do detalhe.
const porSubpagina = new Map(compilados.map((t) => [t.subpagina.toLowerCase(), t]));

const atribuicoes: Array<{ pageId: number; slug: string; score: number }> = [];
let atribuidos = 0;
let inferidos = 0;
let semTema = 0;

for (const r of linhas) {
  // Atribuição humana: a subpágina da lista peculiar é o tema.
  if (r.source_detail) {
    const sufixo = r.source_detail.split("/").pop()?.toLowerCase() ?? "";
    const tema = porSubpagina.get(sufixo);
    if (tema) {
      atribuicoes.push({ pageId: r.page_id, slug: tema.slug, score: 1 });
      atribuidos++;
      continue;
    }
  }

  // Inferência: o primeiro tema cujo padrão casa com o resumo. Um artigo pode
  // caber em vários, mas um tema só mantém o filtro previsível.
  const texto = r.extract ?? "";
  const tema = compilados.find((t) => t.padroes.some((p) => p.test(texto)));
  if (tema) {
    atribuicoes.push({ pageId: r.page_id, slug: tema.slug, score: 0.5 });
    inferidos++;
  } else {
    semTema++;
  }
}

console.log(`Artigos: ${linhas.length}`);
console.log(`  tema atribuído à mão: ${atribuidos}`);
console.log(`  tema inferido do resumo: ${inferidos}`);
console.log(`  sem tema: ${semTema} (${((semTema / linhas.length) * 100).toFixed(1)}%)`);

if (!seco) {
  const gravar = db.transaction(() => {
    db.prepare(`DELETE FROM article_topics WHERE lang = ?`).run(WIKI_LANG);
    db.prepare(`DELETE FROM topics`).run();

    const inserirTema = db.prepare(`INSERT INTO topics (slug, label) VALUES (?, ?)`);
    const ids = new Map<string, number>();
    for (const t of compilados) {
      ids.set(t.slug, Number(inserirTema.run(t.slug, t.label).lastInsertRowid));
    }

    const inserir = db.prepare(
      `INSERT INTO article_topics (lang, page_id, topic_id, score) VALUES (?, ?, ?, ?)`,
    );
    for (const a of atribuicoes) {
      inserir.run(WIKI_LANG, a.pageId, ids.get(a.slug)!, a.score);
    }
  });
  gravar();
}

const resumo = db
  .prepare(
    `SELECT t.label, COUNT(*) n, ROUND(AVG(at.score), 2) confianca
       FROM topics t JOIN article_topics at ON at.topic_id = t.id
      WHERE at.lang = ? GROUP BY t.id ORDER BY n DESC`,
  )
  .all(WIKI_LANG) as { label: string; n: number; confianca: number }[];

console.log("\ntema                  artigos   confiança média");
for (const t of resumo) {
  console.log(
    `  ${t.label.padEnd(18)} ${String(t.n).padStart(7)}   ${t.confianca}`,
  );
}

if (seco) db.close();
else finalizeDb(db);
