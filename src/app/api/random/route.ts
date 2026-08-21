import { NextResponse } from "next/server";
import { randomArticle } from "@/lib/db/pool";
import { MODOS, ehModo } from "@/lib/modes";

// better-sqlite3 é módulo nativo: precisa do runtime Node, não do Edge.
export const runtime = "nodejs";
// O sorteio muda a cada request; nada aqui pode ser cacheado.
export const dynamic = "force-dynamic";

/**
 * GET /api/random?exclude=1,2,3&mode=mixed&topic=historia
 *
 * `exclude` recebe os page_ids já vistos na sessão. `mode` alterna entre
 * qualidade, surpresa e a mistura dos dois; `topic` filtra por tema.
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const exclude = (params.get("exclude") ?? "")
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter(Number.isInteger);

  const modeParam = params.get("mode") ?? undefined;
  if (modeParam !== undefined && !ehModo(modeParam)) {
    return NextResponse.json(
      { error: `mode inválido. Use ${MODOS.join(", ")}.` },
      { status: 400 },
    );
  }

  const topic = params.get("topic")?.trim() || undefined;
  const article = randomArticle({ exclude, mode: modeParam, topic });

  if (!article) {
    return NextResponse.json(
      {
        error: topic
          ? `Nenhum artigo para o tema '${topic}' neste modo.`
          : "Pool vazio. Rode a ingestão: npm run ingest:unusual",
      },
      { status: topic ? 404 : 503 },
    );
  }

  return NextResponse.json(
    { article },
    { headers: { "Cache-Control": "no-store" } },
  );
}
