import { NextResponse } from "next/server";
import { randomArticle } from "@/lib/db/pool";

// better-sqlite3 é módulo nativo: precisa do runtime Node, não do Edge.
export const runtime = "nodejs";
// O sorteio muda a cada request; nada aqui pode ser cacheado.
export const dynamic = "force-dynamic";

/**
 * GET /api/random?exclude=1,2,3
 *
 * `exclude` recebe os page_ids já vistos na sessão. `topic` e `mode` entram na
 * etapa 4, quando existirem scores e tópicos para ponderar.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const exclude = (params.get("exclude") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter(Number.isInteger);

  const article = randomArticle({ exclude });

  if (!article) {
    return NextResponse.json(
      { error: "Pool vazio. Rode a ingestão: npm run ingest:unusual" },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { article },
    { headers: { "Cache-Control": "no-store" } },
  );
}
