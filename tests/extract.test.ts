import { describe, expect, it } from "vitest";
import { cleanExtract, summarize } from "../src/lib/wiki/extract";

describe("cleanExtract", () => {
  it("remove transcrição fonética entre colchetes", () => {
    expect(
      cleanExtract(
        `"Ich bin ein Berliner" (German pronunciation: [ɪç bɪn ʔaɪn bɛʁˈliːnɐ]; "I Am a Berliner") is a speech.`,
      ),
    ).toBe(`"Ich bin ein Berliner" ("I Am a Berliner") is a speech.`);
  });

  it("remove o parêntese vazio deixado pela API", () => {
    expect(cleanExtract("The Voynich manuscript (, VOY-nitch) is an illustrated codex.")).toBe(
      "The Voynich manuscript (VOY-nitch) is an illustrated codex.",
    );
  });

  it("apaga parênteses que ficaram completamente vazios", () => {
    expect(cleanExtract("Toynbee tiles () are messages of unknown origin.")).toBe(
      "Toynbee tiles are messages of unknown origin.",
    );
  });

  it("remove rótulo de idioma que ficou sem valor", () => {
    expect(cleanExtract(`Die Glocke (German:, 'The Bell') was a device.`)).toBe(
      `Die Glocke ('The Bell') was a device.`,
    );
  });

  it("remove o parêntese quando só sobrou o rótulo", () => {
    expect(cleanExtract("Märket (Swedish:) é uma ilha.")).toBe("Märket é uma ilha.");
  });

  it("remove ruído em parêntese aninhado, preservando o conteúdo de fora", () => {
    expect(
      cleanExtract(
        "Triskaidekaphobia (TRIS-kə-; from Ancient Greek τρεισκαίδεκα (treiskaídeka) 'thirteen') is fear of 13.",
      ),
    ).toBe(
      "Triskaidekaphobia (from Ancient Greek τρεισκαίδεκα (treiskaídeka) 'thirteen') is fear of 13.",
    );
  });

  it("remove rótulos órfãos encadeados", () => {
    expect(cleanExtract("The Darién Gap (US:, UK:, Spanish: Tapón) is remote.")).toBe(
      "The Darién Gap (Spanish: Tapón) is remote.",
    );
  });

  it("resolve separadores encavalados que a própria API entrega", () => {
    // A API devolve este lead literalmente assim, já degenerado na origem.
    expect(cleanExtract("A paternoster (, , or ) or paternoster lift is an elevator.")).toBe(
      "A paternoster or paternoster lift is an elevator.",
    );
  });

  it("é idempotente: relimpar não muda mais nada", () => {
    const casos = [
      "A paternoster (, , or ) or paternoster lift is an elevator.",
      `"Ich bin ein Berliner" (German pronunciation: [ɪç bɪn ʔaɪn bɛʁˈliːnɐ]; "I Am a Berliner") is a speech.`,
      "The Darién Gap (US:, UK:, Spanish: Tapón) is remote.",
      "Um artigo perfeitamente normal, sem ruído nenhum.",
    ];
    for (const c of casos) {
      const uma = cleanExtract(c);
      expect(cleanExtract(uma)).toBe(uma);
    }
  });

  it("preserva o operador Elvis, que parece artefato mas é conteúdo", () => {
    const t = "O operador Elvis, escrito ?:, devolve o primeiro operando.";
    expect(cleanExtract(t)).toBe(t);
  });

  it("não trava com parêntese sem fechamento", () => {
    expect(cleanExtract("Texto (aberto sem fim")).toBe("Texto (aberto sem fim");
  });

  it("preserva rótulo que ainda tem valor", () => {
    const t = "A água (Latin: aqua) é essencial.";
    expect(cleanExtract(t)).toBe(t);
  });

  it("preserva parênteses com conteúdo real", () => {
    const t = "O Peel P50 (1962-1965) é o menor carro do mundo.";
    expect(cleanExtract(t)).toBe(t);
  });

  it("preserva colchetes de conteúdo, como interpolação de citação", () => {
    const t = 'Kennedy disse "civis Romanus sum [I am a Roman citizen]" ali.';
    expect(cleanExtract(t)).toBe(t);
  });

  it("corrige espaço antes de pontuação após a remoção", () => {
    expect(cleanExtract("Bir Tawil (IPA: algo) , um território.")).toBe(
      "Bir Tawil, um território.",
    );
  });

  it("não altera texto já limpo", () => {
    const t = "Um artigo perfeitamente normal, sem ruído nenhum.";
    expect(cleanExtract(t)).toBe(t);
  });
});

describe("summarize", () => {
  const tres =
    "Primeira frase curta. Segunda frase um pouco mais longa que a anterior. Terceira frase para estourar o limite imposto no teste.";

  it("devolve o texto inteiro quando já cabe", () => {
    expect(summarize("Curto demais.", 420)).toBe("Curto demais.");
  });

  it("corta em fim de frase, sem cortar palavra ao meio", () => {
    const out = summarize(tres, 75);
    expect(out).toBe("Primeira frase curta. Segunda frase um pouco mais longa que a anterior.");
    expect(out.length).toBeLessThanOrEqual(75);
  });

  it("não estoura o limite por um caractere", () => {
    // As duas primeiras frases somam 71; com 70 só a primeira pode sair.
    expect(summarize(tres, 70)).toBe("Primeira frase curta.");
  });

  it("mantém só a primeira frase quando a segunda não cabe", () => {
    expect(summarize(tres, 30)).toBe("Primeira frase curta.");
  });

  it("corta na palavra e marca com reticências quando nenhuma frase cabe", () => {
    const out = summarize("Uma frase única muito comprida sem nenhum ponto final aqui", 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out).not.toMatch(/\s…$/);
  });

  it("respeita o limite em um lead real de tamanho grande", () => {
    const longo = "Frase de tamanho razoável para o teste. ".repeat(40);
    expect(summarize(longo, 420).length).toBeLessThanOrEqual(420);
  });

  it("não deixa pontuação solta antes das reticências", () => {
    expect(summarize("palavra outra, mais texto que estoura o limite", 15)).not.toMatch(
      /,…$/,
    );
  });
});
