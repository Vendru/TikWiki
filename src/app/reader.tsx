"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolArticle, Topico } from "@/lib/db/pool";
import { MODOS, type Modo } from "@/lib/modes";
import { summarize } from "@/lib/wiki/extract";

/** Teto do histórico guardado, para não crescer sem fim no localStorage. */
const SEEN_LIMIT = 500;
/** Quantos ids acompanham o request; o suficiente para não repetir de imediato. */
const EXCLUDE_LIMIT = 150;
const STORAGE_KEY = "tikwiki:seen";

function loadSeen(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Number.isInteger) : [];
  } catch {
    return [];
  }
}

function saveSeen(ids: number[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-SEEN_LIMIT)));
  } catch {
    // Modo privado ou cota cheia: o histórico é um extra, não vale quebrar.
  }
}

/** Filtros que o usuário controla; mudá-los invalida o que foi pré-buscado. */
interface Filtros {
  topic: string;
  mode: Modo;
}

const ROTULO_MODO: Record<Modo, string> = {
  mixed: "Equilibrado",
  quality: "Mais completos",
  surprise: "Mais obscuros",
};

/**
 * Resultado da busca, com o motivo quando falha.
 *
 * Devolver `undefined` para todo tipo de falha fazia o clique não produzir
 * efeito nenhum: sem artigo novo, sem mensagem, sem nada na tela. O usuário
 * não tem como distinguir "acabou o tema" de "a rede caiu" de "o botão está
 * quebrado" — e a única saída era recarregar a página.
 */
type Resultado =
  | { ok: true; article: PoolArticle }
  | { ok: false; motivo: string };

async function fetchArticle(
  exclude: number[],
  filtros: Filtros,
): Promise<Resultado> {
  const params = new URLSearchParams({
    exclude: exclude.slice(-EXCLUDE_LIMIT).join(","),
    mode: filtros.mode,
  });
  if (filtros.topic) params.set("topic", filtros.topic);

  try {
    const res = await fetch(`/api/random?${params}`, { cache: "no-store" });
    if (!res.ok) {
      const corpo = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, motivo: corpo.error ?? `A busca falhou (${res.status}).` };
    }
    const body = (await res.json()) as { article?: PoolArticle };
    if (!body.article) return { ok: false, motivo: "A resposta veio sem artigo." };
    return { ok: true, article: body.article };
  } catch {
    // fetch rejeita em queda de rede, e o json() rejeita em resposta truncada.
    return { ok: false, motivo: "Sem resposta do servidor." };
  }
}

export default function Reader({
  initial,
  topics,
}: {
  initial: PoolArticle;
  topics: Topico[];
}) {
  const [stack, setStack] = useState<PoolArticle[]>([initial]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // "Surpreenda-me" é o padrão: tema vazio quer dizer o pool inteiro.
  const [filtros, setFiltros] = useState<Filtros>({ topic: "", mode: "mixed" });

  // O próximo artigo é buscado enquanto o atual está na tela, para que
  // "outro" troque no mesmo instante do clique.
  const prefetched = useRef<PoolArticle | undefined>(undefined);
  const seen = useRef<number[]>([initial.pageId]);

  const current = stack[index];
  const canGoBack = index > 0;

  const prefetch = useCallback(async () => {
    if (prefetched.current) return;
    const r = await fetchArticle(seen.current, filtros);
    // Falha no prefetch é silenciosa de propósito: o usuário não pediu nada
    // ainda. O clique seguinte tenta de novo e aí sim reporta.
    if (r.ok) prefetched.current = r.article;
  }, [filtros]);

  useEffect(() => {
    seen.current = [...loadSeen(), initial.pageId];
    saveSeen(seen.current);
  }, [initial.pageId]);

  // Trocar de filtro invalida o que já foi pré-buscado: aquele artigo veio do
  // filtro anterior, e entregá-lo faria o seletor parecer quebrado.
  useEffect(() => {
    prefetched.current = undefined;
    setErro(null);
    void prefetch();
  }, [prefetch]);

  const mostrar = useCallback((article: PoolArticle) => {
    seen.current = [...seen.current, article.pageId].slice(-SEEN_LIMIT);
    saveSeen(seen.current);
    setStack((s) => [...s, article]);
    setIndex((i) => i + 1);
  }, []);

  const next = useCallback(async () => {
    // Se o usuário voltou, avançar refaz o caminho já percorrido.
    if (index < stack.length - 1) {
      setIndex((i) => i + 1);
      return;
    }

    const ready = prefetched.current;
    if (ready) {
      prefetched.current = undefined;
      setErro(null);
      mostrar(ready);
      void prefetch();
      return;
    }

    // Sem prefetch pronto (primeiro clique muito rápido, ou rede lenta).
    setErro(null);
    setLoading(true);
    try {
      const r = await fetchArticle(seen.current, filtros);
      if (!r.ok) {
        setErro(r.motivo);
        return;
      }
      mostrar(r.article);
      void prefetch();
    } finally {
      // Sem o finally, uma exceção deixava o botão desabilitado em "Buscando…"
      // até a página ser recarregada.
      setLoading(false);
    }
  }, [index, stack.length, prefetch, filtros, mostrar]);

  const back = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Teclado: o loop fica rápido para quem não quer tirar a mão do teclado.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        void next();
      } else if (e.key === "ArrowLeft" && canGoBack) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, back, canGoBack]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-6 px-5 py-8 sm:py-12">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-xl tracking-tight">
          Tik<span className="text-accent">Wiki</span>
        </h1>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="sr-only" htmlFor="tema">
            Tema
          </label>
          <select
            id="tema"
            value={filtros.topic}
            onChange={(e) => setFiltros((f) => ({ ...f, topic: e.target.value }))}
            className="rounded-full border border-edge bg-surface px-3 py-1.5 text-paper outline-none transition hover:border-muted focus:border-accent"
          >
            <option value="">Surpreenda-me</option>
            {topics.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.label} ({t.count.toLocaleString("pt-BR")})
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="modo">
            Modo
          </label>
          <select
            id="modo"
            value={filtros.mode}
            onChange={(e) =>
              setFiltros((f) => ({ ...f, mode: e.target.value as Modo }))
            }
            className="rounded-full border border-edge bg-surface px-3 py-1.5 text-paper outline-none transition hover:border-muted focus:border-accent"
          >
            {MODOS.map((m) => (
              <option key={m} value={m}>
                {ROTULO_MODO[m]}
              </option>
            ))}
          </select>
        </div>
      </header>

      <article
        key={current.pageId}
        className="animate-rise flex flex-1 flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl shadow-black/40"
      >
        {current.thumbnailUrl && (
          // Servido direto pelo CDN da Wikimedia, que já entrega o thumbnail
          // no tamanho pedido e é rápido em qualquer região.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={current.thumbnailUrl}
            alt=""
            className="h-56 w-full bg-ink object-cover sm:h-72"
            loading="eager"
          />
        )}

        <div className="flex flex-1 flex-col gap-4 p-6 sm:p-8">
          <h2 className="font-serif text-3xl leading-tight tracking-tight sm:text-4xl">
            {current.title}
          </h2>

          {current.curatorNote && (
            <p className="border-l-2 border-accent pl-4 text-[15px] italic leading-relaxed text-accent/90">
              {current.curatorNote}
            </p>
          )}

          {current.extract && (
            <p className="text-[15px] leading-relaxed text-paper/80">
              {summarize(current.extract)}
            </p>
          )}

          <div className="mt-auto flex flex-wrap gap-3 pt-4">
            <a
              href={current.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-paper px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-white"
            >
              Ler na Wikipédia →
            </a>
            {canGoBack && (
              <button
                type="button"
                onClick={back}
                className="rounded-full border border-edge px-5 py-2.5 text-sm text-muted transition hover:border-muted hover:text-paper"
              >
                ← Anterior
              </button>
            )}
          </div>
        </div>
      </article>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void next()}
          disabled={loading}
          className="w-full rounded-full bg-accent px-6 py-4 text-base font-semibold text-ink transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
        >
          {loading ? "Buscando…" : erro ? "Tentar de novo" : "Outro artigo"}
        </button>

        {erro && (
          <p role="status" className="text-center text-xs leading-relaxed text-accent/90">
            {erro}
            {filtros.topic && " Tente outro tema ou volte para “Surpreenda-me”."}
          </p>
        )}
      </div>

      <footer className="pb-2 text-center text-xs leading-relaxed text-muted">
        Conteúdo da{" "}
        <a
          href="https://www.wikipedia.org"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-paper"
        >
          Wikipédia
        </a>
        , sob a licença{" "}
        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/deed.pt-BR"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-paper"
        >
          CC BY-SA 4.0
        </a>
        .
        <br />
        <span className="text-muted/70">
          Use ← e → ou espaço para navegar.
        </span>
      </footer>
    </main>
  );
}
