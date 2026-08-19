import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../config";
import { WikiApiError, WikiClient } from "../wiki/client";
import { type QueryResponse, requirePages } from "../wiki/parse";
import { stripWikitext } from "../wiki/wikitext";

/**
 * Arquivo do "Você sabia?" — os ganchos que passaram pela capa.
 *
 * Cada entrada é um artigo em negrito dentro de uma frase escrita à mão
 * dizendo por que ele é notável. É o mesmo ativo que a lista de Artigos
 * peculiares oferece, em escala muito maior: nenhuma métrica estrutural
 * produz esse julgamento.
 */
export const SOURCE = "dyk";

interface SourceConfig {
  /** Prefixo das páginas de arquivo dentro do namespace de projeto. */
  archivePrefix: string;
  searchHint: string;
  /** Regex das páginas de arquivo que valem; as demais são histórico e índice. */
  archivePattern: string;
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

/**
 * Descobre as páginas de arquivo via API.
 *
 * São mais de quinhentas e o conjunto cresce, então nunca são fixadas em
 * código. Se o prefixo não achar nada, falha listando candidatos da busca em
 * vez de gravar um pool vazio.
 */
export async function discoverArchives(
  client: WikiClient,
  cfg: SourceConfig,
): Promise<string[]> {
  const namespace = 4;
  const found: string[] = [];

  for await (const body of client.paginate<{
    query?: { allpages?: Array<{ title: string }> };
  }>(
    {
      action: "query",
      list: "allpages",
      apnamespace: namespace,
      apprefix: cfg.archivePrefix,
      aplimit: "max",
    },
    40,
  )) {
    for (const p of body.query?.allpages ?? []) found.push(p.title);
  }

  if (found.length === 0) {
    const search = await client.get<{
      query?: { search?: Array<{ title: string }> };
    }>({
      action: "query",
      list: "search",
      srsearch: cfg.searchHint,
      srnamespace: namespace,
      srlimit: 10,
    });
    const candidatos = (search.query?.search ?? []).map((s) => s.title);
    throw new WikiApiError(
      `Nenhum arquivo com o prefixo '${cfg.archivePrefix}' em ${client.lang}.wikipedia.org. ` +
        `Atualize config/sources.json. Candidatos da busca por '${cfg.searchHint}': ` +
        (candidatos.length ? candidatos.map((c) => `\n  - ${c}`).join("") : "nenhum"),
    );
  }

  const pattern = new RegExp(cfg.archivePattern);
  const arquivos = found.filter((t) => pattern.test(t));

  if (arquivos.length === 0) {
    throw new WikiApiError(
      `${found.length} páginas encontradas sob '${cfg.archivePrefix}', mas nenhuma ` +
        `casa com archivePattern. Exemplos: ${found.slice(0, 5).join(", ")}`,
    );
  }

  return arquivos;
}

export interface Hook {
  title: string;
  /** A frase do gancho, já sem marcação. */
  hook: string;
}

// O artigo destacado do gancho vem em negrito; os demais links são contexto.
const BOLD_LINK = /'''+\s*(?:''')?\s*\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const OTHER_NS = /^(File|Image|Category|Template|Wikipedia|Help|Portal|WP|Talk):/i;

/** Tira o "...that " inicial e as sobras de legenda de imagem. */
function limparGancho(linha: string): string {
  let s = stripWikitext(linha.replace(/^\*+\s*/, ""));
  s = s.replace(/^\.{2,}\s*/, "");
  s = s.replace(/^that\s+/i, "");
  // "(pictured)" e variantes referem-se à foto da capa, que não temos.
  s = s.replace(/\s*\(\s*(?:pictured|imagem|na foto)[^)]*\)/gi, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Extrai os ganchos de uma página de arquivo.
 *
 * Um gancho pode destacar mais de um artigo, e nesse caso todos recebem a
 * mesma frase — ela fala dos dois, e é o que dá contexto a cada um.
 */
export function parseDykHooks(wikitext: string): Hook[] {
  const out: Hook[] = [];

  for (const raw of wikitext.split("\n")) {
    const linha = raw.trim();
    if (!linha.startsWith("*")) continue;

    BOLD_LINK.lastIndex = 0;
    const titulos: string[] = [];
    for (const m of linha.matchAll(BOLD_LINK)) {
      const t = m[1].replace(/_/g, " ").trim();
      if (t && !OTHER_NS.test(t)) titulos.push(t);
    }
    if (titulos.length === 0) continue;

    const hook = limparGancho(linha);
    // Sem a frase, a entrada não vale mais que um link solto.
    if (hook.length < 15) continue;

    for (const title of titulos) out.push({ title, hook });
  }

  return out;
}
