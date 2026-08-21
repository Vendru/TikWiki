import { describe, expect, it } from "vitest";
import { countRefs, countSections } from "../src/lib/wiki/metrics";

describe("countRefs", () => {
  it("conta referências completas", () => {
    expect(countRefs("texto<ref>fonte</ref> mais<ref>outra</ref>")).toBe(2);
  });

  it("conta referências nomeadas e reusadas", () => {
    expect(countRefs(`<ref name="a">fonte</ref> texto <ref name="a" />`)).toBe(2);
  });

  it("conta referência com atributos e quebras de linha", () => {
    expect(countRefs(`<ref\n  name="x"\n  group="nota">fonte</ref>`)).toBe(1);
  });

  it("é insensível a maiúsculas", () => {
    expect(countRefs("<REF>a</REF><Ref>b</Ref>")).toBe(2);
  });

  it("devolve zero em artigo sem referência", () => {
    expect(countRefs("Só prosa, sem nenhuma fonte citada.")).toBe(0);
  });

  it("não conta a tag de fechamento como uma referência a mais", () => {
    expect(countRefs("<ref>uma só</ref>")).toBe(1);
  });
});

describe("countSections", () => {
  it("conta seções de segundo e terceiro nível", () => {
    const w = `Introdução.

== História ==
texto

=== Origem ===
texto

== Ver também ==
`;
    expect(countSections(w)).toBe(3);
  });

  it("ignora o título de primeiro nível, que não é usado em artigos", () => {
    expect(countSections("= Título =\ntexto")).toBe(0);
  });

  it("não confunde igualdade dentro do texto com cabeçalho", () => {
    expect(countSections("A fórmula é a == b no código.")).toBe(0);
  });

  it("aceita espaço sobrando depois do cabeçalho", () => {
    expect(countSections("== Seção ==   \ntexto")).toBe(1);
  });

  it("devolve zero em artigo sem seções", () => {
    expect(countSections("Um artigo curto e corrido, sem divisões.")).toBe(0);
  });
});
