import { WikiApiError } from "./client";

/** Página como devolvida pela Action API com formatversion=2. */
export interface RawPage {
  pageid?: number;
  ns?: number;
  title: string;
  missing?: boolean;
  invalid?: boolean;
  length?: number;
  fullurl?: string;
  extract?: string;
  thumbnail?: { source: string; width: number; height: number };
  pageprops?: Record<string, string>;
}

export interface QueryResponse {
  query?: {
    pages?: RawPage[];
    redirects?: Array<{ from: string; to: string }>;
    normalized?: Array<{ from: string; to: string }>;
  };
}

/**
 * Uma resposta sem `query` significa que nada casou — quase sempre um erro de
 * parâmetro nosso. Falhar aqui é melhor que gravar um pool vazio em silêncio.
 */
export function requirePages(body: QueryResponse, context: string): RawPage[] {
  if (!body.query) {
    throw new WikiApiError(`Resposta sem 'query' em ${context}`);
  }
  return body.query.pages ?? [];
}

/**
 * Mapa dos títulos que a API reescreveu (normalização + redirects), para
 * reassociar o resultado ao título que pedimos.
 */
export function titleRewrites(body: QueryResponse): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of [body.query?.normalized, body.query?.redirects]) {
    for (const { from, to } of step ?? []) map.set(from, to);
  }
  return map;
}

/** Resolve um título original até o destino final, seguindo a cadeia. */
export function resolveTitle(title: string, rewrites: Map<string, string>): string {
  let current = title;
  // Teto pequeno: cadeias reais têm 1-2 saltos; mais que isso é ciclo.
  for (let i = 0; i < 5; i++) {
    const next = rewrites.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

export interface PageFacts {
  pageId: number;
  title: string;
  ns: number;
  bytes: number;
  url?: string;
  extract?: string;
  thumbnailUrl?: string;
  isDisambiguation: boolean;
}

/** Converte uma página crua em fatos, ou undefined se ela não existe. */
export function toPageFacts(page: RawPage): PageFacts | undefined {
  if (page.missing || page.invalid || page.pageid === undefined) return undefined;
  return {
    pageId: page.pageid,
    title: page.title,
    ns: page.ns ?? 0,
    bytes: page.length ?? 0,
    url: page.fullurl,
    extract: page.extract?.trim() || undefined,
    thumbnailUrl: page.thumbnail?.source,
    isDisambiguation: page.pageprops?.disambiguation !== undefined,
  };
}

export interface ParseResponse {
  parse?: {
    title: string;
    pageid: number;
    wikitext?: string;
    redirects?: Array<{ from: string; to: string }>;
  };
}

export function requireWikitext(body: ParseResponse, context: string): string {
  const text = body.parse?.wikitext;
  if (typeof text !== "string") {
    throw new WikiApiError(`Resposta de action=parse sem wikitext em ${context}`);
  }
  return text;
}

const REDIRECT = /^\s*#(?:REDIRECT|REDIRECIONAMENTO)\s*\[\[([^\]|#]+)/i;

/** Detecta um redirect e devolve o alvo, para poder pular sem falhar. */
export function redirectTarget(wikitext: string): string | undefined {
  return REDIRECT.exec(wikitext)?.[1].trim();
}
