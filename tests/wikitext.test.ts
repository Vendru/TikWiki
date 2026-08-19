import { describe, expect, it } from "vitest";
import { parseUnusualList, stripWikitext } from "../src/lib/wiki/wikitext";

describe("stripWikitext", () => {
  it("resolve links com e sem rótulo", () => {
    expect(stripWikitext("um [[taxon|táxon]] e um [[Elvis taxon]]")).toBe(
      "um táxon e um Elvis taxon",
    );
  });

  it("remove templates aninhados", () => {
    expect(stripWikitext("nota{{sarcasm}}{{cn|date={{CURRENTMONTH}}}} final")).toBe(
      "nota final",
    );
  });

  it("remove refs, comentários e HTML", () => {
    expect(
      stripWikitext("texto<ref name=x>fonte</ref><!-- oculto --><br/>mais"),
    ).toBe("texto mais");
  });

  it("remove marcação de itálico e negrito", () => {
    expect(stripWikitext("o ''Dead Parrot'' e o '''Sokal'''")).toBe(
      "o Dead Parrot e o Sokal",
    );
  });

  it("resolve links externos mantendo o rótulo", () => {
    expect(stripWikitext("veja [https://exemplo.org o estudo] aqui")).toBe(
      "veja o estudo aqui",
    );
  });
});

/** Amostra fiel do formato real das subpáginas. */
const TABELA = `
{| class="wikitable"
! Artigo !! Descrição
|-
| '''[[Buttered toast phenomenon]]'''
| But only if you're eating at a table.
|-
| '''[[Claude Émile Jean-Baptiste Litre]]'''
| [[International System of Units|SI]] rules say you can't use a capital letter.
|-
| {{icon|FL}} '''[[Timeline of the far future]]'''
| The ultimate list of spoilers.
|-
| '''''[[Halomonas titanicae]]'''''
| A species found at the [[wreck of the Titanic]].
|-
| '''[[Elvis taxon]]'''
|
|}
`;

describe("parseUnusualList", () => {
  const entries = parseUnusualList(TABELA);

  it("extrai uma entrada por linha da tabela", () => {
    expect(entries.map((e) => e.title)).toEqual([
      "Buttered toast phenomenon",
      "Claude Émile Jean-Baptiste Litre",
      "Timeline of the far future",
      "Halomonas titanicae",
      "Elvis taxon",
    ]);
  });

  it("captura a nota do curador e limpa a marcação", () => {
    expect(entries[1].note).toBe(
      "SI rules say you can't use a capital letter.",
    );
  });

  it("aceita entradas precedidas de template de ícone", () => {
    expect(entries[2].note).toBe("The ultimate list of spoilers.");
  });

  it("aceita negrito-itálico", () => {
    expect(entries[3].title).toBe("Halomonas titanicae");
  });

  it("deixa a nota indefinida quando a célula está vazia", () => {
    expect(entries[4].note).toBeUndefined();
  });

  it("ignora links de contexto dentro das notas", () => {
    // 'International System of Units' e 'wreck of the Titanic' aparecem como
    // links, mas não em negrito — não são entradas da lista.
    expect(entries.map((e) => e.title)).not.toContain("International System of Units");
    expect(entries).toHaveLength(5);
  });

  it("ignora links para outros namespaces", () => {
    const out = parseUnusualList(`|-\n| '''[[File:Foo.jpg]]'''\n| legenda`);
    expect(out).toHaveLength(0);
  });

  it("descarta duplicatas mantendo a primeira ocorrência", () => {
    const out = parseUnusualList(
      `|-\n| '''[[Bir Tawil]]'''\n| primeira\n|-\n| '''[[bir tawil]]'''\n| segunda`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].note).toBe("primeira");
  });

  it("descarta a âncora de seção do título", () => {
    const out = parseUnusualList(`|-\n| '''[[Märket#História]]'''\n| nota`);
    expect(out[0].title).toBe("Märket");
  });

  it("não confunde o cabeçalho da tabela com entrada", () => {
    expect(parseUnusualList(`{| class="wikitable"\n! A !! B\n|}`)).toHaveLength(0);
  });
});
