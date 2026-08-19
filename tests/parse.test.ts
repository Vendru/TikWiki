import { describe, expect, it } from "vitest";
import {
  redirectTarget,
  requirePages,
  requireWikitext,
  resolveTitle,
  titleRewrites,
  toPageFacts,
} from "../src/lib/wiki/parse";
import { WikiApiError } from "../src/lib/wiki/client";

describe("requirePages", () => {
  it("falha alto quando a resposta não tem query", () => {
    expect(() => requirePages({}, "teste")).toThrow(WikiApiError);
  });

  it("aceita query sem páginas como lista vazia", () => {
    expect(requirePages({ query: {} }, "teste")).toEqual([]);
  });
});

describe("toPageFacts", () => {
  it("converte uma página completa", () => {
    const facts = toPageFacts({
      pageid: 42,
      ns: 0,
      title: "Bir Tawil",
      length: 21000,
      fullurl: "https://en.wikipedia.org/wiki/Bir_Tawil",
      extract: "  Um território não reivindicado.  ",
      thumbnail: { source: "https://img/x.jpg", width: 800, height: 600 },
    });
    expect(facts).toEqual({
      pageId: 42,
      title: "Bir Tawil",
      ns: 0,
      bytes: 21000,
      url: "https://en.wikipedia.org/wiki/Bir_Tawil",
      extract: "Um território não reivindicado.",
      thumbnailUrl: "https://img/x.jpg",
      isDisambiguation: false,
    });
  });

  it("descarta páginas inexistentes ou inválidas", () => {
    expect(toPageFacts({ title: "Nada", missing: true })).toBeUndefined();
    expect(toPageFacts({ title: "<>", invalid: true })).toBeUndefined();
  });

  it("marca desambiguação pela pageprop", () => {
    const facts = toPageFacts({
      pageid: 1,
      ns: 0,
      title: "Mercúrio",
      pageprops: { disambiguation: "" },
    });
    expect(facts?.isDisambiguation).toBe(true);
  });

  it("trata extract vazio como ausente", () => {
    expect(toPageFacts({ pageid: 1, ns: 0, title: "X", extract: "   " })?.extract)
      .toBeUndefined();
  });
});

describe("resolveTitle", () => {
  const body = {
    query: {
      normalized: [{ from: "bir tawil", to: "Bir tawil" }],
      redirects: [{ from: "Bir tawil", to: "Bir Tawil" }],
    },
  };

  it("segue normalização e redirect encadeados", () => {
    expect(resolveTitle("bir tawil", titleRewrites(body))).toBe("Bir Tawil");
  });

  it("devolve o título original quando não há reescrita", () => {
    expect(resolveTitle("Märket", titleRewrites(body))).toBe("Märket");
  });

  it("não trava em ciclo", () => {
    const ciclo = new Map([
      ["A", "B"],
      ["B", "A"],
    ]);
    expect(() => resolveTitle("A", ciclo)).not.toThrow();
  });
});

describe("redirectTarget", () => {
  it("detecta redirect e devolve o alvo sem âncora", () => {
    expect(
      redirectTarget("#REDIRECT [[Wikipedia:Unusual articles/Science#Phobias]]"),
    ).toBe("Wikipedia:Unusual articles/Science");
  });

  it("é insensível a maiúsculas", () => {
    expect(redirectTarget("#redirect [[Alvo]]")).toBe("Alvo");
  });

  it("devolve undefined para conteúdo normal", () => {
    expect(redirectTarget("{| class=wikitable\n|-\n| '''[[X]]'''")).toBeUndefined();
  });
});

describe("requireWikitext", () => {
  it("falha alto quando action=parse não traz wikitext", () => {
    expect(() => requireWikitext({}, "Página X")).toThrow(/sem wikitext/);
  });
});
