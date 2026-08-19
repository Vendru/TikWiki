import { randomArticle } from "@/lib/db/pool";
import Reader from "./reader";

export const runtime = "nodejs";
// O primeiro artigo é sorteado a cada visita, então a página não é estática.
export const dynamic = "force-dynamic";

export default function Home() {
  const initial = randomArticle();

  if (!initial) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-3 px-6 text-center">
        <h1 className="font-serif text-2xl">Pool vazio</h1>
        <p className="text-sm text-muted">
          Rode a ingestão antes de subir o app:
        </p>
        <code className="rounded-lg border border-edge bg-surface px-4 py-3 text-sm text-accent">
          npm run ingest:unusual
        </code>
      </main>
    );
  }

  // O primeiro artigo vem renderizado do servidor: a tela abre com conteúdo,
  // sem estado de carregamento.
  return <Reader initial={initial} />;
}
