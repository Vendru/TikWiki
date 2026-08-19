import { describe, expect, it } from "vitest";
import {
  RejectionReport,
  loadFilters,
  proseRatio,
  reject,
} from "../src/lib/filters";

const f = loadFilters();
const base = { title: "Bir Tawil", ns: 0, bytes: 20000 };

describe("config de filtros", () => {
  it("carrega e compila as regras do arquivo", () => {
    expect(f.minBytes).toBe(6000);
    expect(f.title.length).toBeGreaterThan(0);
    expect(f.category.length).toBeGreaterThan(0);
  });
});

describe("reject — regras baratas", () => {
  it("aprova um artigo comum", () => {
    expect(reject(base, f)).toBeUndefined();
  });

  it("derruba fora do namespace 0", () => {
    expect(reject({ ...base, ns: 4 }, f)).toBe("namespace");
  });

  it("derruba desambiguação pela pageprop", () => {
    expect(reject({ ...base, isDisambiguation: true }, f)).toBe("desambiguacao_pageprop");
  });

  it("derruba abaixo do mínimo de bytes", () => {
    expect(reject({ ...base, bytes: 5999 }, f)).toBe("bytes_minimo");
    expect(reject({ ...base, bytes: 6000 }, f)).toBeUndefined();
  });
});

describe("reject — padrões de título", () => {
  const casos: Array<[string, string]> = [
    ["List of unusual deaths", "titulo:lista"],
    ["Lists of lists", "titulo:lista"],
    ["Index of philosophy articles", "titulo:lista"],
    ["Outline of chess", "titulo:lista"],
    ["Mercury (disambiguation)", "titulo:desambiguacao"],
    ["1997", "titulo:ano_isolado"],
    ["44 BC", "titulo:ano_isolado"],
    ["1990s", "titulo:ano_isolado"],
    ["Politics in 2011", "titulo:evento_datado"],
    ["2011 Formula One season", "titulo:evento_datado"],
    ["Copa do Mundo em 1970", "titulo:evento_datado"],
    ["Michael Jackson discography", "titulo:discografia_elenco"],
  ];

  for (const [title, rule] of casos) {
    it(`derruba "${title}" por ${rule}`, () => {
      expect(reject({ ...base, title }, f)).toBe(rule);
    });
  }

  it("não confunde título legítimo que contém número", () => {
    expect(reject({ ...base, title: "Apollo 11" }, f)).toBeUndefined();
    expect(reject({ ...base, title: "Catch-22" }, f)).toBeUndefined();
  });

  it("não derruba artigo cujo nome apenas começa com maiúscula parecida", () => {
    expect(reject({ ...base, title: "Listeria" }, f)).toBeUndefined();
    expect(reject({ ...base, title: "Indexation" }, f)).toBeUndefined();
  });
});

describe("reject — categorias", () => {
  const comCat = (categories: string[]) => reject({ ...base, categories }, f);

  it("derruba asteroides", () => {
    expect(comCat(["Main-belt asteroids"])).toBe("categoria:asteroides_corpos_menores");
  });

  it("derruba táxons", () => {
    expect(comCat(["Beetle genera", "Insects of Europe"])).toBe("categoria:taxons");
  });

  it("derruba localidades em suas várias formas", () => {
    // Cada uma destas passou numa varredura real antes de a regra existir.
    for (const cat of [
      "Census-designated places in Texas",
      "Cities and towns in Apulia",
      "Frazioni of the Province of Lecce",
      "Municipalities of Aklan",
      "Localities of Salento",
    ]) {
      expect(comCat([cat])).toBe("categoria:localidades");
    }
  });

  it("derruba estações ferroviárias", () => {
    expect(comCat(["Railway stations in Japan"])).toBe("categoria:estacoes_ferroviarias");
  });

  it("derruba escolas", () => {
    expect(comCat(["High schools in California"])).toBe("categoria:escolas");
  });

  it("derruba discografias", () => {
    expect(comCat(["Discographies of British artists"])).toBe(
      "categoria:discografias_elencos",
    );
  });

  it("aprova categorias comuns", () => {
    expect(comCat(["Deserts of Africa", "Disputed territories"])).toBeUndefined();
  });

  it("lista de categorias vazia não derruba", () => {
    expect(comCat([])).toBeUndefined();
  });
});

describe("proseRatio", () => {
  it("dá quase zero para artigo que é só ficha", () => {
    const ficha = `{{Taxobox
| name = Foo
| regnum = Animalia
| genus = Bar
}}
'''Bar''' é um gênero.

== Referências ==
* item
`;
    expect(proseRatio(ficha)).toBeLessThan(0.35);
  });

  it("dá valor alto para artigo de prosa corrida", () => {
    const prosa = "Este é um artigo com bastante texto corrido. ".repeat(30);
    expect(proseRatio(prosa)).toBeGreaterThan(0.9);
  });

  it("não conta tabelas como prosa", () => {
    const tabela = `{| class="wikitable"\n| a || b\n|-\n| c || d\n|}\nUm.`;
    expect(proseRatio(tabela)).toBeLessThan(0.35);
  });

  it("devolve zero para wikitext vazio", () => {
    expect(proseRatio("   ")).toBe(0);
  });
});

describe("reject — wikitext", () => {
  const prosa = "Texto corrido de verdade neste artigo, com bastante conteúdo. ".repeat(20);

  it("derruba template de esboço", () => {
    expect(reject({ ...base, wikitext: `${prosa}\n{{Europe-geo-stub}}` }, f)).toBe("esboco");
  });

  it("derruba esboço em português", () => {
    expect(reject({ ...base, wikitext: `${prosa}\n{{esboço-biografia}}` }, f)).toBe("esboco");
  });

  it("distingue ficha reconhecida de prosa insuficiente", () => {
    // Taxobox de tamanho realista: é justamente a desproporção entre a ficha
    // e a única frase de prosa que caracteriza o artigo a descartar.
    const taxon = `{{Speciesbox
| image = Foo bar.jpg
| image_caption = Um exemplar em campo
| status = LC
| status_system = IUCN3.1
| status_ref = <ref name=iucn/>
| genus = Foo
| species = bar
| authority = (Linnaeus, 1758)
| synonyms = ''Baz qux'' Smith, 1802
| synonyms_ref = <ref name=cat/>
| range_map = Foo bar range.png
| range_map_caption = Distribuição conhecida
}}
'''Foo bar''' é uma espécie de besouro.

== Referências ==
* item
`;
    expect(reject({ ...base, wikitext: taxon }, f)).toBe("ficha_sem_prosa");

    const tabelao = `{| class="wikitable"\n${"| linha || valor\n|-\n".repeat(40)}|}\nUm.`;
    expect(reject({ ...base, wikitext: tabelao }, f)).toBe("prosa_insuficiente");
  });

  it("aprova artigo com prosa suficiente", () => {
    expect(reject({ ...base, wikitext: prosa }, f)).toBeUndefined();
  });

  it("sem wikitext, as regras de conteúdo não reprovam", () => {
    expect(reject(base, f)).toBeUndefined();
  });
});

describe("RejectionReport", () => {
  it("soma aprovados e rejeitados até o total", () => {
    const r = new RejectionReport();
    r.record("bytes_minimo");
    r.record("bytes_minimo");
    r.record("namespace");
    r.record(undefined);

    const s = r.summary;
    expect(s.total).toBe(4);
    expect(s.passed).toBe(1);
    expect(s.rejected).toBe(3);
    expect(s.byRule[0]).toEqual(["bytes_minimo", 2]);
  });

  it("formata sem quebrar quando nada foi avaliado", () => {
    expect(new RejectionReport().format()).toContain("nenhum candidato");
  });
});
