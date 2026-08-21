import { describe, expect, it } from "vitest";
import { parseUnusualList, stripWikitext, tidyNote } from "../src/lib/wiki/wikitext";

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

describe("tidyNote", () => {
  it("remove atributos de célula que precedem o conteúdo", () => {
    expect(tidyNote(`width="70%" | Uses its testicles as a weapon.`)).toBe(
      "Uses its testicles as a weapon.",
    );
    expect(tidyNote(`rowspan="2" | Two violent criminals who did not exist.`)).toBe(
      "Two violent criminals who did not exist.",
    );
  });

  it("remove vários atributos encadeados", () => {
    expect(tidyNote(`align=center width="70%" | Texto real.`)).toBe("Texto real.");
  });

  it("remove referência à foto em qualquer forma", () => {
    // A forma exata '(pictured)' já saía; estas escapavam.
    expect(tidyNote("An American group ran campaigns (example pictured) worldwide.")).toBe(
      "An American group ran campaigns worldwide.",
    );
    expect(tidyNote("O elefante (pictured in 2005) foi um presente.")).toBe(
      "O elefante foi um presente.",
    );
  });

  it("decodifica entidades HTML que sobrevivem ao wikitext", () => {
    // Chegavam cruas ao card, inclusive nos melhores artigos do pool:
    // "Death from laughter: Don't laugh&nbsp;– it's happened."
    expect(tidyNote("Don't laugh&nbsp;&ndash; it's happened.")).toBe(
      "Don't laugh – it's happened.",
    );
    expect(tidyNote("World War&nbsp;II foi travada num castelo.")).toBe(
      "World War II foi travada num castelo.",
    );
    expect(tidyNote("Fish &amp; chips com 20&deg;C.")).toBe("Fish & chips com 20°C.");
  });

  it("decodifica entidades numéricas, decimais e hexadecimais", () => {
    expect(tidyNote("Caf&#233; e ch&#xE1;.")).toBe("Café e chá.");
  });

  it("deixa intacto o que não é entidade conhecida", () => {
    const t = "A empresa AT&T e a fórmula a &lt; b.";
    expect(tidyNote(t)).toBe("A empresa AT&T e a fórmula a < b.");
  });

  it("não estoura com entidade numérica fora de faixa", () => {
    expect(() => tidyNote("Lixo &#99999999999;.")).not.toThrow();
  });

  it("não confunde parêntese legítimo com legenda", () => {
    const t = "O Peel P50 (1962-1965) é o menor carro do mundo.";
    expect(tidyNote(t)).toBe(t);
  });

  it("não come uma barra que faz parte do texto", () => {
    const t = "A relação entre entrada | saída é direta.";
    expect(tidyNote(t)).toBe(t);
  });

  it("começa com maiúscula", () => {
    expect(tidyNote(`width="70%" | uma nota em minúscula.`)).toBe(
      "Uma nota em minúscula.",
    );
  });

  it("devolve vazio para nota vazia, sem estourar", () => {
    expect(tidyNote("   ")).toBe("");
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
    // A nota sai capitalizada por tidyNote; o que se testa aqui é qual ficou.
    expect(out[0].note).toBe("Primeira");
  });

  it("descarta a âncora de seção do título", () => {
    const out = parseUnusualList(`|-\n| '''[[Märket#História]]'''\n| nota`);
    expect(out[0].title).toBe("Märket");
  });

  it("não confunde o cabeçalho da tabela com entrada", () => {
    expect(parseUnusualList(`{| class="wikitable"\n! A !! B\n|}`)).toHaveLength(0);
  });
});
