import { REQUEST_INTERVAL_MS, USER_AGENT } from "../config";
import { DiskCache } from "./cache";
import { WikiApiError, WikiClient } from "./client";
import { type QueryResponse, requirePages } from "./parse";

/**
 * Coleta das métricas por artigo.
 *
 * Tudo que dá é buscado em lote. A audiência é a exceção: a API de analytics
 * é por artigo, então só roda em quem já passou pelo filtro.
 */

/** Lotes menores para wikitext: 50 revisões inteiras devolvem megabytes. */
const WIKITEXT_BATCH = 20;
const PROP_BATCH = 50;

interface RevisionPage {
  pageid?: number;
  title: string;
  missing?: boolean;
  revisions?: Array<{ slots?: { main?: { content?: string } } }>;
}

/** Wikitext de vários títulos por request, para refs, esboço e prosa. */
export async function fetchWikitext(
  client: WikiClient,
  titles: string[],
  onBatch?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let done = 0;

  for (const batch of WikiClient.batchTitles(titles, WIKITEXT_BATCH)) {
    const body = await client.get<{ query?: { pages?: RevisionPage[] } }>({
      action: "query",
      titles: batch.join("|"),
      prop: "revisions",
      rvprop: "content",
      rvslots: "main",
      redirects: 1,
    });
    for (const page of body.query?.pages ?? []) {
      const content = page.revisions?.[0]?.slots?.main?.content;
      if (content) out.set(page.title, content);
    }
    done += batch.length;
    onBatch?.(Math.min(done, titles.length), titles.length);
  }

  return out;
}

export interface CountedProps {
  langlinks: Map<string, number>;
  images: Map<string, number>;
  categories: Map<string, string[]>;
}

/**
 * Conta langlinks e imagens e coleta categorias, em lote.
 *
 * Estas propriedades são paginadas por item, não por página, então um lote de
 * 50 títulos pode precisar de várias continuações — daí o uso do paginador.
 */
export async function fetchCountedProps(
  client: WikiClient,
  titles: string[],
  onBatch?: (done: number, total: number) => void,
): Promise<CountedProps> {
  const langlinks = new Map<string, number>();
  const images = new Map<string, number>();
  const categories = new Map<string, string[]>();
  let done = 0;

  for (const batch of WikiClient.batchTitles(titles, PROP_BATCH)) {
    for await (const body of client.paginate<QueryResponse>(
      {
        action: "query",
        titles: batch.join("|"),
        prop: "langlinks|images|categories",
        lllimit: "max",
        imlimit: "max",
        cllimit: "max",
        clshow: "!hidden",
        redirects: 1,
      },
      60,
    )) {
      const pages = requirePages(body, `fetchCountedProps(${batch[0]}…)`) as Array<
        {
          title: string;
          langlinks?: unknown[];
          images?: unknown[];
          categories?: Array<{ title: string }>;
        }
      >;
      for (const page of pages) {
        if (page.langlinks) {
          langlinks.set(
            page.title,
            (langlinks.get(page.title) ?? 0) + page.langlinks.length,
          );
        }
        if (page.images) {
          images.set(page.title, (images.get(page.title) ?? 0) + page.images.length);
        }
        if (page.categories) {
          const prior = categories.get(page.title) ?? [];
          // Guarda o nome sem o prefixo de namespace: as regras do filtro
          // são escritas contra o nome legível.
          const names = page.categories.map((c) =>
            c.title.includes(":") ? c.title.slice(c.title.indexOf(":") + 1) : c.title,
          );
          categories.set(page.title, [...prior, ...names]);
        }
      }
    }
    done += batch.length;
    onBatch?.(Math.min(done, titles.length), titles.length);
  }

  return { langlinks, images, categories };
}

/**
 * Conta quantos artigos apontam para cada título, com teto.
 *
 * O teto existe porque a contagem exata de um artigo muito linkado custaria
 * dezenas de continuações e o log já comprime essa faixa. Mas ele não pode
 * ficar perto do topo da distribuição: com teto de 500, 5,7% do pool saturava
 * e o p99 inteiro valia exatamente 500 — justamente os artigos que o ranking
 * precisa separar. 2000 deixa a saturação abaixo de 1% e só custa requests
 * extras para os poucos que passam de 500, porque a paginação para no teto.
 */
export async function fetchBacklinks(
  client: WikiClient,
  titles: string[],
  cap = 2000,
  onBatch?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let done = 0;

  for (const title of titles) {
    let count = 0;
    for await (const body of client.paginate<QueryResponse>(
      {
        action: "query",
        titles: title,
        prop: "linkshere",
        lhlimit: "max",
        lhnamespace: 0,
        lhshow: "!redirect",
        redirects: 1,
      },
      Math.ceil(cap / 500) + 1,
    )) {
      const pages = (body.query?.pages ?? []) as Array<{ linkshere?: unknown[] }>;
      for (const page of pages) count += page.linkshere?.length ?? 0;
      if (count >= cap) break;
    }
    out.set(title, Math.min(count, cap));
    done++;
    onBatch?.(done, titles.length);
  }

  return out;
}

/**
 * Conta as referências no wikitext.
 *
 * Casa a tag de abertura, o que inclui a forma reusada `<ref name="x" />` —
 * uma fonte citada em cinco pontos conta cinco vezes, que é o comportamento
 * desejado: mede densidade de citação, não fontes distintas.
 */
export function countRefs(wikitext: string): number {
  return wikitext.match(/<ref[^>]*>/gi)?.length ?? 0;
}

/**
 * Conta os cabeçalhos de seção (`==` e `===`), que são os dois níveis usados
 * em artigos — `=` é reservado ao título da página.
 */
export function countSections(wikitext: string): number {
  return wikitext.match(/^={2,3}[^=].*?={2,3}\s*$/gm)?.length ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ritmo da API de analytics, que é outra da Action API e tem cota própria.
 *
 * Ela não passa pelo WikiClient, então precisa do próprio freio: sem ele a
 * corrida dispara no ritmo da rede e derruba a cota, que foi exatamente como
 * a Action API acabou recusando tudo por horas.
 */
let proximoSlotPageviews = 0;

async function ritmoPageviews(): Promise<void> {
  const intervalo = REQUEST_INTERVAL_MS;
  const agora = Date.now();
  const espera = Math.max(0, proximoSlotPageviews - agora);
  proximoSlotPageviews = Math.max(agora, proximoSlotPageviews) + intervalo;
  if (espera > 0) await sleep(espera);
}

/**
 * Média mensal de visualizações nos últimos 12 meses.
 *
 * Esta é a única chamada que não é em lote — a API de analytics é por artigo.
 * Roda só sobre quem passou pelo filtro, para não pagar por artigo descartado.
 * Um 404 significa artigo sem histórico de audiência, não erro.
 */
export async function fetchPageviews(
  lang: string,
  title: string,
  months = 12,
  cache?: DiskCache,
): Promise<number | undefined> {
  // A janela entra na chave: virou o mês, o dado é outro.
  const key = `pageviews|${lang}|${title}|${months}|${new Date()
    .toISOString()
    .slice(0, 7)}`;
  const hit = cache?.get<{ v: number | null }>(key);
  if (hit) return hit.v ?? undefined;

  const end = new Date();
  end.setUTCDate(1);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - months);

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}0100`;

  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
    `${lang}.wikipedia/all-access/user/${encodeURIComponent(
      title.replace(/ /g, "_"),
    )}/monthly/${fmt(start)}/${fmt(end)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 400 + Math.random() * 200);
    await ritmoPageviews();

    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch {
      continue;
    }

    // Artigo sem histórico de audiência: ausência de dado, não falha.
    if (res.status === 404) {
      cache?.set(key, { v: null });
      return undefined;
    }
    if (res.status === 429 || res.status >= 500) continue;
    if (!res.ok) {
      throw new WikiApiError(`Pageviews HTTP ${res.status} para ${title}`, res.status);
    }

    const body = (await res.json()) as { items?: Array<{ views: number }> };
    const items = body.items ?? [];
    const avg =
      items.length === 0
        ? undefined
        : items.reduce((sum, i) => sum + i.views, 0) / items.length;
    cache?.set(key, { v: avg ?? null });
    return avg;
  }

  return undefined;
}
