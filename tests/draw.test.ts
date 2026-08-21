import { describe, expect, it } from "vitest";
import {
  type DrawConfig,
  ehModo,
  escolherPorPeso,
  loadDrawConfig,
  peso,
  sortearFonte,
} from "../src/lib/draw";

const cfg = loadDrawConfig();

/** Gerador determinístico, para a distribuição ser verificável. */
function sequencia(valores: number[]) {
  let i = 0;
  return () => valores[i++ % valores.length];
}

describe("config de sorteio", () => {
  it("carrega os pesos por fonte", () => {
    expect(cfg.porFonte.unusual).toBeGreaterThan(0);
    expect(cfg.candidatos).toBeGreaterThan(1);
  });

  it("tem os três modos que a especificação pede", () => {
    for (const m of ["quality", "surprise", "mixed"]) {
      expect(cfg.modos[m as keyof typeof cfg.modos]).toBeDefined();
      expect(ehModo(m)).toBe(true);
    }
    expect(ehModo("qualquer")).toBe(false);
  });
});

describe("sortearFonte", () => {
  const disponiveis = new Map([
    ["unusual", 4202],
    ["dyk", 121101],
    ["random", 127],
  ]);

  it("segue os pesos, não o tamanho da fonte", () => {
    // É o ponto do sorteio em duas etapas: a lista peculiar é 3,3% do pool e
    // precisa aparecer muito mais que isso.
    const contagem = new Map<string, number>();
    let semente = 0;
    for (let i = 0; i < 10000; i++) {
      const r = sortearFonte(disponiveis, cfg, () => {
        semente = (semente * 1103515245 + 12345) % 2147483648;
        return semente / 2147483648;
      })!;
      contagem.set(r, (contagem.get(r) ?? 0) + 1);
    }
    const total = [...contagem.values()].reduce((s, n) => s + n, 0);
    const esperado = cfg.porFonte.unusual / Object.values(cfg.porFonte).reduce((s, n) => s + n, 0);
    expect(contagem.get("unusual")! / total).toBeCloseTo(esperado, 1);
  });

  it("ignora fonte sem artigo elegível", () => {
    const vazia = new Map([
      ["unusual", 0],
      ["dyk", 100],
    ]);
    for (let i = 0; i < 50; i++) {
      expect(sortearFonte(vazia, cfg)).toBe("dyk");
    }
  });

  it("cai para qualquer fonte com artigo quando nenhuma está configurada", () => {
    const desconhecida = new Map([["fonte-nova", 10]]);
    expect(sortearFonte(desconhecida, cfg)).toBe("fonte-nova");
  });

  it("devolve undefined quando não há artigo nenhum", () => {
    expect(sortearFonte(new Map([["dyk", 0]]), cfg)).toBeUndefined();
  });
});

describe("peso", () => {
  const artigo = { scoreQuality: 100, scoreSurprise: 40 };

  it("usa só a qualidade no modo quality", () => {
    expect(peso(artigo, "quality", cfg)).toBe(100);
  });

  it("usa só a surpresa no modo surprise", () => {
    expect(peso(artigo, "surprise", cfg)).toBe(40);
  });

  it("mistura os dois no modo mixed", () => {
    expect(peso(artigo, "mixed", cfg)).toBe(70);
  });

  it("nunca devolve peso negativo", () => {
    // A surpresa vai a -62,6 no pool medido, e peso negativo não existe.
    const impopular = { scoreQuality: 20, scoreSurprise: -62.6 };
    expect(peso(impopular, "surprise", cfg)).toBeGreaterThanOrEqual(cfg.pisoDoPeso);
  });

  it("trata score ausente como zero, caindo no piso", () => {
    expect(peso({ scoreQuality: null, scoreSurprise: null }, "mixed", cfg)).toBe(
      cfg.pisoDoPeso,
    );
  });
});

describe("escolherPorPeso", () => {
  const candidatos = [
    { id: "fraco", scoreQuality: 10, scoreSurprise: 0 },
    { id: "forte", scoreQuality: 90, scoreSurprise: 0 },
  ];

  it("favorece o de maior peso ao longo de muitos sorteios", () => {
    const contagem = new Map<string, number>();
    let semente = 1;
    for (let i = 0; i < 4000; i++) {
      const r = escolherPorPeso(candidatos, "quality", cfg, () => {
        semente = (semente * 1103515245 + 12345) % 2147483648;
        return semente / 2147483648;
      })!;
      contagem.set(r.id, (contagem.get(r.id) ?? 0) + 1);
    }
    // 90 contra 10: o forte deve ficar perto de 90% das escolhas.
    expect(contagem.get("forte")! / 4000).toBeGreaterThan(0.8);
    // Mas o fraco não pode sumir — a especificação pede sorteio ponderado,
    // não "sempre o melhor".
    expect(contagem.get("fraco")!).toBeGreaterThan(0);
  });

  it("devolve undefined sem candidatos", () => {
    expect(escolherPorPeso([], "quality", cfg)).toBeUndefined();
  });

  it("com um candidato só, devolve ele", () => {
    expect(escolherPorPeso([candidatos[0]], "quality", cfg)?.id).toBe("fraco");
  });

  it("não trava quando todos os pesos são iguais", () => {
    const iguais = [
      { id: "a", scoreQuality: 0, scoreSurprise: 0 },
      { id: "b", scoreQuality: 0, scoreSurprise: 0 },
    ];
    const vistos = new Set<string>();
    for (let i = 0; i < 200; i++) vistos.add(escolherPorPeso(iguais, "quality", cfg)!.id);
    expect(vistos.size).toBe(2);
  });

  it("respeita o último candidato quando o sorteio cai na borda", () => {
    // Um gerador que sempre devolve o valor máximo não pode estourar o laço.
    const r = escolherPorPeso(candidatos, "quality", cfg, sequencia([0.9999999]));
    expect(r).toBeDefined();
  });
});
