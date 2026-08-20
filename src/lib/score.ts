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
  /** Valor de referência (p90 do pool) que faz o termo valer exatamente `weight`. */
  ref: number;
}

export interface ScoreConfig {
  quality: Record<string, Term>;
  curatedBonus: { value: number };
  surprise: {
    pageviewsWeight: number;
    pageviewsScale: number;
    pageviewsRef: number;
    /** Abaixo disto a audiência é tratada como não medida. */
    pageviewsMinimo?: number;
  };
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

/**
 * Normaliza o termo pelo seu valor de referência, para que o peso signifique
 * o que aparenta significar.
 *
 * Sem isso os pesos enganam: como cada métrica tem uma dispersão própria
 * depois do log, `sections` com peso 0,8 respondia por 1% da variância do
 * score enquanto `backlinks` com peso 2,0 respondia por 29%. Dividindo pelo
 * log da referência, um artigo no p90 daquela métrica contribui exatamente
 * `weight`, e os pesos passam a ser comparáveis entre si.
 */
const normalized = (value: number, term: Term) => {
  const denominator = compress(term.ref, term.scale);
  if (!(denominator > 0)) return 0;
  return compress(value, term.scale) / denominator;
};

/**
 * Qualidade na escala de 0 a 100, onde 100 é o p90 de todas as métricas.
 *
 * O total é dividido pelo peso das métricas de fato presentes, não pelo peso
 * total. Sem isso, artigo com métrica faltando pontuaria sistematicamente
 * abaixo de quem tem tudo — e como medir backlinks e audiência custa um
 * request por artigo, essa diferença de cobertura é a regra, não a exceção.
 *
 * Métrica ausente e métrica zero passam a ser coisas diferentes, que é o
 * certo: `refs: null` é "não medimos" e sai da conta; `refs: 0` é "medimos e
 * não há nenhuma", e puxa a média para baixo.
 */
export function qualityScore(
  m: Metrics,
  cfg: ScoreConfig,
  opts: { curated?: boolean } = {},
): number {
  let total = 0;
  let pesoDisponivel = 0;

  for (const [name, term] of Object.entries(cfg.quality)) {
    const raw = m[name as keyof Metrics];
    if (raw === null || raw === undefined) continue;
    pesoDisponivel += term.weight;
    total += term.weight * normalized(raw, term);
  }

  const bonus = opts.curated ? cfg.curatedBonus.value : 0;
  if (pesoDisponivel === 0) return Math.round(bonus * 100) / 100;

  const score = (total / pesoDisponivel) * 100 + bonus;
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

  // Audiência quase nula num artigo bem desenvolvido contradiz o resto das
  // métricas, e quase sempre significa que o título foi renomeado e o
  // histórico ficou com o nome antigo. Tratar como não medida evita que o
  // artefato lidere o ranking de surpresa, que foi o que aconteceu com
  // "Foreign policy of the Modi government" e suas 1,1 visualizações por mês.
  const minimo = cfg.surprise.pageviewsMinimo ?? 0;
  if (m.pageviews < minimo) return quality;

  const penalty =
    cfg.surprise.pageviewsWeight *
    10 *
    normalized(m.pageviews, {
      weight: 1,
      scale: cfg.surprise.pageviewsScale,
      ref: cfg.surprise.pageviewsRef,
    });
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
