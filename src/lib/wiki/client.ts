import {
  MAX_RETRIES,
  REQUEST_INTERVAL_MS,
  TITLES_PER_REQUEST,
  USER_AGENT,
  WIKI_LANG,
  apiEndpoint,
} from "../config";
import { DiskCache } from "./cache";

export type Params = Record<string, string | number | boolean | undefined>;

export class WikiApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WikiApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClientOptions {
  lang?: string;
  cache?: DiskCache;
  /** Ignora o cache de leitura, mas continua gravando. */
  refresh?: boolean;
  onRequest?: (info: { params: Params; cached: boolean }) => void;
}

export class WikiClient {
  readonly lang: string;
  private readonly cache: DiskCache;
  private readonly refresh: boolean;
  private readonly onRequest?: ClientOptions["onRequest"];
  private nextSlot = 0;

  constructor(opts: ClientOptions = {}) {
    this.lang = opts.lang ?? WIKI_LANG;
    this.cache = opts.cache ?? new DiskCache();
    this.refresh = opts.refresh ?? false;
    this.onRequest = opts.onRequest;
  }

  /** Serializa os requests respeitando o intervalo mínimo configurado. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + REQUEST_INTERVAL_MS;
    if (wait > 0) await sleep(wait);
  }

  private cacheKey(params: Params): string {
    const entries = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `${this.lang}|${JSON.stringify(entries)}`;
  }

  /** Um request à Action API, com cache, throttle e retry. */
  async get<T = unknown>(params: Params): Promise<T> {
    const full: Params = {
      ...params,
      format: "json",
      formatversion: 2,
      // Erros como JSON estruturado em vez do formato legado.
      errorformat: "plaintext",
    };
    const key = this.cacheKey(full);

    if (!this.refresh) {
      const hit = this.cache.get<T>(key);
      if (hit !== undefined) {
        this.onRequest?.({ params, cached: true });
        return hit;
      }
    }

    const url = new URL(apiEndpoint(this.lang));
    for (const [k, v] of Object.entries(full)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const body = await this.fetchWithRetry(url);
    this.onRequest?.({ params, cached: false });

    // A API responde 200 mesmo em erro de módulo; o erro vem no corpo.
    const err = (body as { errors?: Array<{ code: string; text?: string }> })
      .errors?.[0];
    if (err) {
      throw new WikiApiError(
        `API retornou erro '${err.code}': ${err.text ?? "sem detalhe"}`,
        200,
        err.code,
      );
    }

    this.cache.set(key, body);
    return body as T;
  }

  private async fetchWithRetry(url: URL): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        // Backoff exponencial com jitter, para não sincronizar retries.
        const backoff = 2 ** attempt * 500 + Math.random() * 250;
        await sleep(backoff);
      }
      await this.throttle();

      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
        });
      } catch (cause) {
        // Falha de rede: vale retry.
        lastError = cause;
        continue;
      }

      if (res.ok) return res.json();

      if (res.status === 429 || res.status >= 500) {
        lastError = new WikiApiError(
          `HTTP ${res.status} em ${url.pathname}${url.search.slice(0, 200)}`,
          res.status,
        );
        continue;
      }

      // 4xx que não seja 429 não melhora com retry — falha alto e claro.
      throw new WikiApiError(
        `HTTP ${res.status} em ${url.href}: ${(await res.text()).slice(0, 300)}`,
        res.status,
      );
    }

    throw new WikiApiError(
      `Esgotadas ${MAX_RETRIES} tentativas: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * Percorre a continuação da API acumulando páginas de resultado.
   * `limit` é um teto de requests, para nunca girar sem fim.
   */
  async *paginate<T = Record<string, unknown>>(
    params: Params,
    limit = 100,
  ): AsyncGenerator<T & { continue?: Record<string, string> }> {
    let cont: Params = {};
    for (let i = 0; i < limit; i++) {
      const body = await this.get<T & { continue?: Record<string, string> }>({
        ...params,
        ...cont,
      });
      yield body;
      if (!body.continue) return;
      cont = body.continue;
    }
    throw new WikiApiError(
      `Paginação excedeu ${limit} requests para ${JSON.stringify(params)}`,
    );
  }

  /** Quebra uma lista de títulos em lotes de 50, o máximo aceito por request. */
  static batchTitles(titles: string[], size = TITLES_PER_REQUEST): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < titles.length; i += size) {
      out.push(titles.slice(i, i + size));
    }
    return out;
  }
}
