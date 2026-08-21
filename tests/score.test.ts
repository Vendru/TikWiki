import { describe, expect, it } from "vitest";
import {
  type Metrics,
  loadScoreConfig,
  qualityScore,
  scoreArticle,
  surpriseScore,
} from "../src/lib/score";

const cfg = loadScoreConfig();

const cheio: Metrics = {
  bytes: 20000,
  langlinks: 30,
  backlinks: 200,
  refs: 40,
  sections: 8,
  images: 5,
  pageviews: 1000,
};

describe("qualityScore", () => {
  it("cresce com métrica melhor", () => {
    const menor = qualityScore({ ...cheio, backlinks: 10 }, cfg);
    const maior = qualityScore({ ...cheio, backlinks: 500 }, cfg);
    expect(maior).toBeGreaterThan(menor);
  });

  it("comprime a cauda longa em vez de deixar uma métrica dominar", () => {
    // Cem vezes mais backlinks não pode valer cem vezes mais score, senão o
    // pool inteiro vira os mesmos artigos gigantes.
    const a = qualityScore({ backlinks: 50 }, cfg);
    const b = qualityScore({ backlinks: 5000 }, cfg);
    expect(b / a).toBeLessThan(3);
    expect(b).toBeGreaterThan(a);
  });

  it("trata métrica ausente como não medida, não como zero ruim", () => {
    const semRefs = qualityScore({ ...cheio, refs: null }, cfg);
    const comRefsZero = qualityScore({ ...cheio, refs: 0 }, cfg);
    // log10(1+0) = 0, então os dois batem: ausente não penaliza além de zero.
    expect(semRefs).toBe(comRefsZero);
  });

  it("dá zero para artigo sem métrica nenhuma", () => {
    expect(qualityScore({}, cfg)).toBe(0);
  });

  it("aplica o bônus de fonte curada", () => {
    const sem = qualityScore(cheio, cfg);
    const com = qualityScore(cheio, cfg, { curated: true });
    expect(com - sem).toBeCloseTo(cfg.curatedBonus.value, 5);
  });

  it("ignora métrica negativa em vez de gerar NaN", () => {
    expect(Number.isFinite(qualityScore({ backlinks: -5 }, cfg))).toBe(true);
  });

  it("o bônus desempata a favor da curadoria entre iguais", () => {
    const metricas = { bytes: 7000, langlinks: 2, backlinks: 8, refs: 6 };
    expect(qualityScore(metricas, cfg, { curated: true })).toBeGreaterThan(
      qualityScore(metricas, cfg),
    );
  });

  it("o bônus fecha a distância mediana entre curados e varredura ampla", () => {
    const medianaCurado = qualityScore(
      { bytes: 13580, langlinks: 11, backlinks: 44, refs: 15, sections: 5, images: 3 },
      cfg,
      { curated: true },
    );
    const medianaVarredura = qualityScore(
      { bytes: 5194, langlinks: 4, backlinks: 12, refs: 6, sections: 3, images: 1 },
      cfg,
    );
    expect(medianaCurado).toBeGreaterThan(medianaVarredura);
  });

  it("um artigo no p90 de todas as métricas vale 100", () => {
    // É o que a normalização compra: a escala passa a ter significado, em vez
    // de depender da dispersão que cada métrica tem depois do log.
    const p90 = Object.fromEntries(
      Object.entries(cfg.quality).map(([nome, termo]) => [nome, termo.ref]),
    ) as Metrics;
    expect(qualityScore(p90, cfg)).toBeCloseTo(100, 1);
  });

  it("cada termo contribui exatamente o próprio peso no p90", () => {
    // Sem a normalização, o peso nominal não correspondia à influência real:
    // sections com peso 0,8 respondia por 1% da variância do score.
    for (const [nome, termo] of Object.entries(cfg.quality)) {
      const so = qualityScore({ [nome]: termo.ref } as Metrics, cfg);
      expect(so).toBeCloseTo(termo.weight * 10, 1);
    }
  });

  it("os pesos somam 10, para o p90 geral dar 100", () => {
    const soma = Object.values(cfg.quality).reduce((s, t) => s + t.weight, 0);
    expect(soma).toBeCloseTo(10, 5);
  });

  it("uma métrica acima da referência ultrapassa o próprio peso", () => {
    const t = cfg.quality.backlinks;
    expect(qualityScore({ backlinks: t.ref * 10 }, cfg)).toBeGreaterThan(t.weight * 10);
  });
});

describe("surpriseScore", () => {
  it("penaliza audiência alta", () => {
    const q = qualityScore(cheio, cfg);
    const obscuro = surpriseScore({ ...cheio, pageviews: 20 }, cfg, q);
    const popular = surpriseScore({ ...cheio, pageviews: 500000 }, cfg, q);
    expect(obscuro).toBeGreaterThan(popular);
  });

  it("sem dado de audiência, surpresa cai para qualidade", () => {
    const q = qualityScore(cheio, cfg);
    expect(surpriseScore({ ...cheio, pageviews: null }, cfg, q)).toBe(q);
    expect(surpriseScore({ ...cheio, pageviews: undefined }, cfg, q)).toBe(q);
  });

  it("inverte o ranking entre dois artigos de mesma qualidade", () => {
    const a = scoreArticle({ ...cheio, pageviews: 50 }, cfg);
    const b = scoreArticle({ ...cheio, pageviews: 100000 }, cfg);
    expect(a.quality).toBe(b.quality);
    expect(a.surprise).toBeGreaterThan(b.surprise);
  });

  it("um artigo ruim e obscuro não vence um ótimo e obscuro", () => {
    const ruim = scoreArticle({ bytes: 6000, backlinks: 1, pageviews: 5 }, cfg);
    const otimo = scoreArticle(
      { bytes: 40000, langlinks: 40, backlinks: 300, refs: 60, sections: 12, pageviews: 5 },
      cfg,
    );
    expect(otimo.surprise).toBeGreaterThan(ruim.surprise);
  });
});

describe("scoreArticle", () => {
  it("devolve os dois scores de uma vez", () => {
    const { quality, surprise } = scoreArticle(cheio, cfg);
    expect(quality).toBeGreaterThan(0);
    expect(surprise).toBeLessThan(quality);
  });

  it("arredonda para duas casas, para o banco não guardar ruído", () => {
    const { quality } = scoreArticle(cheio, cfg);
    expect(quality).toBe(Math.round(quality * 100) / 100);
  });
});
