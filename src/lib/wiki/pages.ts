import { WikiClient } from "./client";
import {
  type PageFacts,
  type QueryResponse,
  requirePages,
  toPageFacts,
} from "./parse";

/**
 * A Action API aceita 50 títulos por request, mas prop=extracts limita a 20 por
 * request para clientes anônimos. Como queremos o resumo junto dos metadados,
 * o lote efetivo é 20 — ainda assim uma ordem de grandeza melhor que 1 por
 * título, que é o ponto do batching.
 */
export const FACTS_BATCH = 20;

/**
 * Busca metadados + resumo + thumbnail de uma lista de títulos, em lote.
 * Devolve um mapa do título pedido para os fatos da página final (após
 * normalização e redirects). Títulos inexistentes ficam de fora do mapa.
 */
export async function fetchPageFacts(
  client: WikiClient,
  titles: string[],
  onBatch?: (done: number, total: number) => void,
): Promise<Map<string, PageFacts>> {
  const out = new Map<string, PageFacts>();
  const batches = WikiClient.batchTitles(titles, FACTS_BATCH);
  let done = 0;

  for (const batch of batches) {
    const body = await client.get<QueryResponse>({
      action: "query",
      titles: batch.join("|"),
      redirects: 1,
      prop: "info|extracts|pageimages|pageprops",
      inprop: "url",
      exintro: 1,
      explaintext: 1,
      exsectionformat: "plain",
      exlimit: "max",
      piprop: "thumbnail",
      pithumbsize: 800,
      pilimit: "max",
      ppprop: "disambiguation",
    });

    const pages = requirePages(body, `fetchPageFacts(${batch[0]}…)`);
    // Reassocia o título pedido ao destino final, seguindo normalização e
    // redirects, para não perder entradas que a API reescreveu.
    const byTitle = new Map<string, PageFacts>();
    for (const page of pages) {
      const facts = toPageFacts(page);
      if (facts) byTitle.set(facts.title, facts);
    }

    const rewrites = new Map<string, string>();
    for (const step of [body.query?.normalized, body.query?.redirects]) {
      for (const { from, to } of step ?? []) rewrites.set(from, to);
    }

    for (const requested of batch) {
      let current = requested;
      for (let i = 0; i < 5; i++) {
        const next = rewrites.get(current);
        if (!next || next === current) break;
        current = next;
      }
      const facts = byTitle.get(current);
      if (facts) out.set(requested, facts);
    }

    done += batch.length;
    onBatch?.(Math.min(done, titles.length), titles.length);
  }

  return out;
}
