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

/** Faixa de rowid por idioma, medida uma vez por processo. */
const faixas = new Map<string, { min: number; max: number } | undefined>();

function faixaDe(lang: string) {
  if (!faixas.has(lang)) {
    const r = db()
      .prepare(`SELECT MIN(rowid) min, MAX(rowid) max FROM articles WHERE lang = ?`)
      .get(lang) as { min: number | null; max: number | null };
    faixas.set(
      lang,
      r.min === null || r.max === null ? undefined : { min: r.min, max: r.max },
    );
  }
  return faixas.get(lang);
}

/** Quantas vezes tentar um rowid sorteado antes de cair no caminho lento. */
const TENTATIVAS = 12;

/**
 * Sorteia um artigo do pool.
 *
 * O sorteio é por rowid, não por ORDER BY RANDOM(): com 128 mil artigos, o
 * segundo varre e ordena a tabela inteira a cada request — medido em 157 ms
 * com exclusões, contra menos de 1 ms por aqui. Sortear o rowid direto usa o
 * índice primário e não depende do tamanho do pool.
 *
 * O sorteio é uniforme por enquanto; a ponderação por score entra na etapa 4.
 */
export function randomArticle(opts: RandomOptions = {}): PoolArticle | undefined {
  const lang = opts.lang ?? WIKI_LANG;
  const faixa = faixaDe(lang);
  if (!faixa) return undefined;

  // Sanitiza: só inteiros, e com teto para não montar SQL gigante.
  const exclude = new Set(
    (opts.exclude ?? []).filter((n) => Number.isInteger(n)).slice(0, 200),
  );

  const porRowid = db().prepare(
    `SELECT ${COLUMNS} FROM articles WHERE rowid = ? AND lang = ?`,
  );

  // O rowid tem buracos onde houve remoção, então uma tentativa pode não
  // achar nada. Sortear de novo mantém a distribuição uniforme, o que um
  // 'rowid >= ?' não faria: ele favoreceria quem vem logo depois do buraco.
  const largura = faixa.max - faixa.min + 1;
  for (let i = 0; i < TENTATIVAS; i++) {
    const alvo = faixa.min + Math.floor(Math.random() * largura);
    const row = porRowid.get(alvo, lang) as Row | undefined;
    if (row && !exclude.has(row.page_id)) return toArticle(row);
  }

  // Buracos demais, ou exclusões cobrindo quase tudo. Aqui a varredura vale a
  // pena porque é o caso raro, e devolver algo é melhor que devolver nada.
  const holes = [...exclude].map(() => "?").join(",");
  const row = db()
    .prepare(
      `SELECT ${COLUMNS} FROM articles
        WHERE lang = ?${exclude.size ? ` AND page_id NOT IN (${holes})` : ""}
        ORDER BY RANDOM() LIMIT 1`,
    )
    .get(lang, ...exclude) as Row | undefined;
  if (row) return toArticle(row);

  // Pool exaurido pelas exclusões: repetir é melhor que não devolver nada.
  const qualquer = db()
    .prepare(`SELECT ${COLUMNS} FROM articles WHERE lang = ? ORDER BY RANDOM() LIMIT 1`)
    .get(lang) as Row | undefined;
  return qualquer ? toArticle(qualquer) : undefined;
}

export function poolSize(lang: string = WIKI_LANG): number {
  const r = db()
    .prepare(`SELECT COUNT(*) AS n FROM articles WHERE lang = ?`)
    .get(lang) as { n: number };
  return r.n;
}
