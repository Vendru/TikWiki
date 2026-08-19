"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PoolArticle } from "@/lib/db/pool";
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

async function fetchArticle(exclude: number[]): Promise<PoolArticle | undefined> {
  const query = exclude.slice(-EXCLUDE_LIMIT).join(",");
  const res = await fetch(`/api/random?exclude=${query}`, { cache: "no-store" });
  if (!res.ok) return undefined;
  const body = (await res.json()) as { article?: PoolArticle };
  return body.article;
}

export default function Reader({ initial }: { initial: PoolArticle }) {
  const [stack, setStack] = useState<PoolArticle[]>([initial]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);

  // O próximo artigo é buscado enquanto o atual está na tela, para que
  // "outro" troque no mesmo instante do clique.
  const prefetched = useRef<PoolArticle | undefined>(undefined);
  const seen = useRef<number[]>([initial.pageId]);

  const current = stack[index];
  const canGoBack = index > 0;

  const prefetch = useCallback(async () => {
    if (prefetched.current) return;
    const article = await fetchArticle(seen.current);
    if (article) prefetched.current = article;
  }, []);

  useEffect(() => {
    seen.current = [...loadSeen(), initial.pageId];
    saveSeen(seen.current);
    void prefetch();
  }, [initial.pageId, prefetch]);

  const next = useCallback(async () => {
    // Se o usuário voltou, avançar refaz o caminho já percorrido.
    if (index < stack.length - 1) {
      setIndex((i) => i + 1);
      return;
    }

    const ready = prefetched.current;
    if (ready) {
      prefetched.current = undefined;
      seen.current = [...seen.current, ready.pageId].slice(-SEEN_LIMIT);
      saveSeen(seen.current);
      setStack((s) => [...s, ready]);
      setIndex((i) => i + 1);
      void prefetch();
      return;
    }

    // Sem prefetch pronto (primeiro clique muito rápido, ou rede lenta).
    setLoading(true);
    const article = await fetchArticle(seen.current);
    setLoading(false);
    if (!article) return;
    seen.current = [...seen.current, article.pageId].slice(-SEEN_LIMIT);
    saveSeen(seen.current);
    setStack((s) => [...s, article]);
    setIndex((i) => i + 1);
    void prefetch();
  }, [index, stack.length, prefetch]);

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
      <header className="flex items-baseline justify-between">
        <h1 className="font-serif text-xl tracking-tight">
          Tik<span className="text-accent">Wiki</span>
        </h1>
        <p className="text-xs text-muted">um artigo interessante por vez</p>
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

      <button
        type="button"
        onClick={() => void next()}
        disabled={loading}
        className="w-full rounded-full bg-accent px-6 py-4 text-base font-semibold text-ink transition hover:brightness-110 active:scale-[0.99] disabled:opacity-60"
      >
        {loading ? "Buscando…" : "Outro artigo"}
      </button>

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
