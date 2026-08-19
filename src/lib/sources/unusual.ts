import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config";
import { WikiApiError, WikiClient } from "../wiki/client";
import {
  type ParseResponse,
  type QueryResponse,
  redirectTarget,
  requirePages,
  requireWikitext,
} from "../wiki/parse";
import { type ListEntry, parseUnusualList } from "../wiki/wikitext";

export const SOURCE = "unusual";

interface SourceConfig {
  hub: string;
  searchHint: string;
  excludeSubpages: string[];
}

export function loadConfig(lang: string): SourceConfig {
  const file = path.join(CONFIG_DIR, "sources.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const cfg = all[SOURCE]?.[lang];
  if (!cfg) {
    const known = Object.keys(all[SOURCE] ?? {}).join(", ");
    throw new Error(
      `Fonte '${SOURCE}' não configurada para o idioma '${lang}' em ${file}. ` +
        `Idiomas configurados: ${known || "nenhum"}.`,
    );
  }
  return cfg;
}

export interface Hub {
  title: string;
  ns: number;
}

/**
 * Confirma que a página-índice configurada existe de fato. Os títulos de
 * páginas-meta variam por idioma e mudam com o tempo, então nunca assumimos
 * que o valor da config ainda vale: se não existir, buscamos candidatos e
 * falhamos com eles à mostra, em vez de ingerir um pool vazio.
 */
export async function resolveHub(
  client: WikiClient,
  cfg: SourceConfig,
): Promise<Hub> {
  const body = await client.get<QueryResponse>({
    action: "query",
    titles: cfg.hub,
    prop: "info",
    redirects: 1,
  });
  const page = requirePages(body, `resolveHub(${cfg.hub})`)[0];

  if (page && !page.missing && !page.invalid && page.pageid !== undefined) {
    return { title: page.title, ns: page.ns ?? 4 };
  }

  const search = await client.get<{
    query?: { search?: Array<{ title: string; ns: number }> };
  }>({
    action: "query",
    list: "search",
    srsearch: cfg.searchHint,
    srnamespace: page?.ns ?? 4,
    srlimit: 10,
  });
  const candidates = (search.query?.search ?? []).map((s) => s.title);

  throw new WikiApiError(
    `Página-índice '${cfg.hub}' não existe em ${client.lang}.wikipedia.org. ` +
      `Atualize config/sources.json. Candidatos da busca por '${cfg.searchHint}': ` +
      (candidates.length ? candidates.map((c) => `\n  - ${c}`).join("") : "nenhum"),
  );
}

/**
 * Descobre as subpáginas do índice via API. O conteúdo real da lista está nelas
 * — o hub só as transclui — e o conjunto muda, então não pode ser fixo.
 */
export async function discoverSubpages(
  client: WikiClient,
  hub: Hub,
  cfg: SourceConfig,
): Promise<string[]> {
  // apprefix é relativo ao namespace, então tiramos o prefixo do título.
  const bare = hub.title.includes(":")
    ? hub.title.slice(hub.title.indexOf(":") + 1)
    : hub.title;

  const found: string[] = [];
  for await (const body of client.paginate<{
    query?: { allpages?: Array<{ title: string }> };
  }>({
    action: "query",
    list: "allpages",
    apnamespace: hub.ns,
    apprefix: `${bare}/`,
    aplimit: "max",
  })) {
    for (const p of body.query?.allpages ?? []) found.push(p.title);
  }

  if (found.length === 0) {
    throw new WikiApiError(
      `Nenhuma subpágina encontrada sob '${hub.title}'. A estrutura da lista ` +
        `provavelmente mudou — verifique a página antes de seguir.`,
    );
  }

  const excluded = new Set(
    cfg.excludeSubpages.map((s) => `${hub.title}${s}`.toLowerCase()),
  );
  return found.filter((t) => !excluded.has(t.toLowerCase()));
}

export interface CollectedEntry extends ListEntry {
  /** Subpágina que trouxe a entrada, guardada como source_detail. */
  subpage: string;
}

export interface CollectResult {
  entries: Map<string, CollectedEntry>;
  perSubpage: Array<{ subpage: string; count: number; redirect?: string }>;
}

/** Lê cada subpágina e junta as entradas curadas, deduplicando por título. */
export async function collectEntries(
  client: WikiClient,
  subpages: string[],
): Promise<CollectResult> {
  const entries = new Map<string, CollectedEntry>();
  const perSubpage: CollectResult["perSubpage"] = [];

  for (const subpage of subpages) {
    const body = await client.get<ParseResponse>({
      action: "parse",
      page: subpage,
      prop: "wikitext",
    });
    const wikitext = requireWikitext(body, subpage);

    // Subpáginas viram redirect quando uma seção é fundida em outra; o conteúdo
    // já vem pelo alvo, então pular é o certo — não é erro.
    const target = redirectTarget(wikitext);
    if (target) {
      perSubpage.push({ subpage, count: 0, redirect: target });
      continue;
    }

    const parsed = parseUnusualList(wikitext);
    for (const entry of parsed) {
      const key = entry.title.toLowerCase();
      const existing = entries.get(key);
      // Mantém a primeira ocorrência, mas aproveita uma nota se faltava.
      if (!existing) {
        entries.set(key, { ...entry, subpage });
      } else if (!existing.note && entry.note) {
        existing.note = entry.note;
      }
    }
    perSubpage.push({ subpage, count: parsed.length });
  }

  return { entries, perSubpage };
}
