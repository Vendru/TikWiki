import { NextResponse } from "next/server";
import { topics } from "@/lib/db/pool";

export const runtime = "nodejs";

/**
 * GET /api/topics → temas disponíveis, com a contagem de cada um.
 *
 * O pool é read-only e muda no máximo semanalmente, então a resposta pode ser
 * cacheada por bastante tempo — ao contrário do sorteio.
 */
export function GET() {
  return NextResponse.json(
    { topics: topics() },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
