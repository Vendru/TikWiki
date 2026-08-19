import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config";

/**
 * Score de qualidade e score de surpresa.
 *
 * Os dois são guardados em colunas distintas para que o sorteio pondere entre
 * eles na hora do request, em vez de fixar uma preferência na ingestão.
 */

export interface Term {
  weight: number;
  scale: number;
}

export interface ScoreConfig {
  quality: Record<string, Term>;
  curatedBonus: { value: number };
  surprise: { pageviewsWeight: number; pageviewsScale: number };
}

export function loadScoreConfig(): ScoreConfig {
  const file = path.join(CONFIG_DIR, "score.json");
  return JSON.parse(fs.readFileSync(file, "utf8")) as ScoreConfig;
}

/** Métricas cruas de um artigo. Ausente (null/undefined) conta como zero. */
export interface Metrics {
  backlinks?: number | null;
  langlinks?: number | null;
  refs?: number | null;
  sections?: number | null;
  images?: number | null;
  bytes?: number | null;
  pageviews?: number | null;
}

/**
 * Comprime uma métrica de cauda longa. Um artigo com 50.000 backlinks não é
 * cinquenta vezes melhor que um com 1.000 — sem o log ele dominaria o pool.
 */
const compress = (value: number, scale: number) =>
  Math.log10(1 + Math.max(0, value) / scale);

export function qualityScore(
  m: Metrics,
  cfg: ScoreConfig,
  opts: { curated?: boolean } = {},
): number {
  let total = 0;
  for (const [name, term] of Object.entries(cfg.quality)) {
    const raw = m[name as keyof Metrics];
    if (raw === null || raw === undefined) continue;
    total += term.weight * compress(raw, term.scale);
  }
  const score = total * 10 + (opts.curated ? cfg.curatedBonus.value : 0);
  return Math.round(score * 100) / 100;
}

/**
 * Qualidade descontada da audiência.
 *
 * Sem dado de audiência o desconto não se aplica: não dá para afirmar que o
 * artigo é obscuro, então ele fica com a própria qualidade.
 */
export function surpriseScore(
  m: Metrics,
  cfg: ScoreConfig,
  quality: number,
): number {
  if (m.pageviews === null || m.pageviews === undefined) return quality;
  const penalty =
    cfg.surprise.pageviewsWeight *
    10 *
    compress(m.pageviews, cfg.surprise.pageviewsScale);
  return Math.round((quality - penalty) * 100) / 100;
}

export function scoreArticle(
  m: Metrics,
  cfg: ScoreConfig,
  opts: { curated?: boolean } = {},
): { quality: number; surprise: number } {
  const quality = qualityScore(m, cfg, opts);
  return { quality, surprise: surpriseScore(m, cfg, quality) };
}
