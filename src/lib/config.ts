import path from "node:path";

/** Idioma alvo da wiki. Toda a pipeline e o app leem daqui. */
export const WIKI_LANG = process.env.WIKI_LANG ?? "en";

/**
 * A política de acesso da Wikimedia exige um User-Agent descritivo com forma de
 * contato; requests sem isso são bloqueados. Deixamos configurável para que
 * quem rodar a pipeline aponte para o próprio contato.
 */
export const CONTACT =
  process.env.WIKI_CONTACT ?? "https://github.com/vendru/tikwiki";

export const USER_AGENT = `TikWiki/0.1 (${CONTACT})`;

export const apiEndpoint = (lang: string = WIKI_LANG) =>
  `https://${lang}.wikipedia.org/w/api.php`;

export const articleUrl = (title: string, lang: string = WIKI_LANG) =>
  `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_"),
  )}`;

const root = process.cwd();

/**
 * Caminhos lidos do ambiente na hora do uso, não no carregamento do módulo:
 * scripts e testes precisam apontar para outro pool sem depender da ordem em
 * que os imports foram avaliados.
 */
export const dbPath = () =>
  process.env.TIKWIKI_DB ?? path.join(root, "data", "pool.db");

export const cacheDir = () =>
  process.env.TIKWIKI_CACHE ?? path.join(root, ".cache", "wiki");

export const CONFIG_DIR = path.join(root, "config");

/** Intervalo mínimo entre requests, em ms. Conservador de propósito. */
export const REQUEST_INTERVAL_MS = Number(process.env.WIKI_INTERVAL_MS ?? 200);

/**
 * Teto de tentativas em 429/5xx antes de desistir.
 *
 * Folgado de propósito: numa corrida de centenas de milhares de requests o
 * servidor pede para desacelerar de tempos em tempos, e desistir cedo derruba
 * a corrida inteira por um contratempo passageiro.
 */
export const MAX_RETRIES = Number(process.env.WIKI_MAX_RETRIES ?? 8);

/** Máximo de títulos por request aceito pela Action API para clientes anônimos. */
export const TITLES_PER_REQUEST = 50;
