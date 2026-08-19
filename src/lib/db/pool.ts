import "server-only";
import { WIKI_LANG } from "../config";
import { type DB, openDb } from "./index";

/**
 * O pool é read-only em produção: um artefato de build, nunca escrito durante
 * um request. Uma conexão só, reaproveitada entre requests.
 */
let handle: DB | undefined;

function db(): DB {
  if (!handle) handle = openDb({ readonly: true });
  return handle;
}

export interface PoolArticle {
  pageId: number;
  title: string;
  url: string;
  extract: string | null;
  thumbnailUrl: string | null;
  curatorNote: string | null;
  source: string;
}

interface Row {
  page_id: number;
  title: string;
  url: string;
  extract: string | null;
  thumbnail_url: string | null;
  curator_note: string | null;
  source: string;
}

const toArticle = (r: Row): PoolArticle => ({
  pageId: r.page_id,
  title: r.title,
  url: r.url,
  extract: r.extract,
  thumbnailUrl: r.thumbnail_url,
  curatorNote: r.curator_note,
  source: r.source,
});

const COLUMNS = `page_id, title, url, extract, thumbnail_url, curator_note, source`;

export interface RandomOptions {
  lang?: string;
  /** page_ids já vistos na sessão, para não repetir. */
  exclude?: number[];
}

/**
 * Sorteia um artigo do pool.
 *
 * O sorteio é uniforme por enquanto: os scores ainda não existem (etapa 3) e a
 * ponderação por score entra na etapa 4. Com o pool na casa dos milhares, o
 * ORDER BY RANDOM() custa um scan barato e evita inventar um esquema de
 * amostragem que vai ser substituído.
 */
export function randomArticle(opts: RandomOptions = {}): PoolArticle | undefined {
  const lang = opts.lang ?? WIKI_LANG;
  // Sanitiza: só inteiros, e com teto para não montar SQL gigante.
  const exclude = (opts.exclude ?? [])
    .filter((n) => Number.isInteger(n))
    .slice(0, 200);

  if (exclude.length > 0) {
    const holes = exclude.map(() => "?").join(",");
    const row = db()
      .prepare(
        `SELECT ${COLUMNS} FROM articles
          WHERE lang = ? AND page_id NOT IN (${holes})
          ORDER BY RANDOM() LIMIT 1`,
      )
      .get(lang, ...exclude) as Row | undefined;
    // Só cai fora quando o usuário exauriu o pool; aí repetir é melhor que
    // devolver nada.
    if (row) return toArticle(row);
  }

  const row = db()
    .prepare(
      `SELECT ${COLUMNS} FROM articles WHERE lang = ? ORDER BY RANDOM() LIMIT 1`,
    )
    .get(lang) as Row | undefined;
  return row ? toArticle(row) : undefined;
}

export function poolSize(lang: string = WIKI_LANG): number {
  const r = db()
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  return r.n;
}
