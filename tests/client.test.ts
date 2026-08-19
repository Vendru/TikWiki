import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiApiError, WikiClient } from "../src/lib/wiki/client";
import { DiskCache } from "../src/lib/wiki/cache";

/** Cache que não toca no disco, para os testes ficarem isolados. */
class CacheVazio extends DiskCache {
  get() {
    return undefined;
  }
  set() {}
}

const resposta = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

const recusa = (retryAfter?: string) =>
  new Response("slow down", {
    status: 429,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

/** Roda a promessa adiantando os timers, já que o cliente dorme entre tentativas. */
async function comTimers<T>(p: Promise<T>): Promise<T> {
  let pronto = false;
  const done = p.then(
    (v) => ((pronto = true), { ok: true as const, v }),
    (e) => ((pronto = true), { ok: false as const, e }),
  );
  // Avança em passos largos e para assim que a promessa resolve, para o teste
  // não pagar por tempo virtual que ninguém vai esperar.
  for (let i = 0; i < 60 && !pronto; i++) {
    await vi.advanceTimersByTimeAsync(30_000);
  }
  const r = await done;
  if (!r.ok) throw r.e;
  return r.v;
}

const cliente = () => new WikiClient({ cache: new CacheVazio("/dev/null") });

describe("WikiClient — recusa por excesso de requests", () => {
  it("desiste depois do teto de tentativas, dizendo o que houve", async () => {
    globalThis.fetch = vi.fn(async () => recusa()) as unknown as typeof fetch;
    const c = cliente();
    await expect(comTimers(c.get({ action: "query" }))).rejects.toThrow(/429/);
  });

  it("volta a funcionar quando o servidor libera", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () =>
      ++n <= 2 ? recusa() : resposta({ query: { pages: [] } }),
    ) as unknown as typeof fetch;

    const c = cliente();
    await expect(comTimers(c.get({ action: "query" }))).resolves.toEqual({
      query: { pages: [] },
    });
    expect(c.recusasObservadas).toBe(2);
  });

  it("registra cada recusa, para a corrida poder ser auditada", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () =>
      ++n <= 3 ? recusa() : resposta({ ok: 1 }),
    ) as unknown as typeof fetch;

    const c = cliente();
    await comTimers(c.get({ action: "query" }));
    expect(c.recusasObservadas).toBe(3);
  });

  it("respeita o Retry-After em vez de tentar no próprio ritmo", async () => {
    let n = 0;
    const chamadas: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      chamadas.push(Date.now());
      return ++n <= 1 ? recusa("5") : resposta({ ok: 1 });
    }) as unknown as typeof fetch;

    const c = cliente();
    await comTimers(c.get({ action: "query" }));
    // A segunda tentativa não pode vir antes dos 5 segundos pedidos.
    expect(chamadas[1] - chamadas[0]).toBeGreaterThanOrEqual(5000);
  });

  it("ignora Retry-After absurdo em vez de travar a corrida", async () => {
    let n = 0;
    const chamadas: number[] = [];
    globalThis.fetch = vi.fn(async () => {
      chamadas.push(Date.now());
      return ++n <= 1 ? recusa("86400") : resposta({ ok: 1 });
    }) as unknown as typeof fetch;

    const c = cliente();
    await comTimers(c.get({ action: "query" }));
    // 86400s viraria um dia de espera; o teto de 60s vale, mais o backoff
    // normal da tentativa, que é da ordem de segundos.
    expect(chamadas[1] - chamadas[0]).toBeLessThan(70_000);
  });

  it("um 4xx que não seja 429 falha na hora, sem repetir", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 404 }));
    globalThis.fetch = f as unknown as typeof fetch;

    const c = cliente();
    await expect(comTimers(c.get({ action: "query" }))).rejects.toThrow(WikiApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("repete em 5xx", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () =>
      ++n <= 2 ? new Response("boom", { status: 503 }) : resposta({ ok: 1 }),
    ) as unknown as typeof fetch;

    const c = cliente();
    await expect(comTimers(c.get({ action: "query" }))).resolves.toEqual({ ok: 1 });
  });
});
