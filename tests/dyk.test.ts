import { describe, expect, it } from "vitest";
import { parseDykHooks } from "../src/lib/sources/dyk";

/** Trecho fiel de um arquivo real. */
const ARQUIVO = `
==April 3==
*...that '''[[Anne Lynch Botta]]''' ''([[:File:Anne Charlotte Lynch Botta.jpg|pictured]])'' introduced [[Edgar Allan Poe]] to literary society at her receptions?
*...that '''[[Emil Calmanovici]]''', the main financial backer of the [[Romanian Communist Party]] in the 1940s, was later imprisoned by [[Communist Romania|Communist authorities]] and died as a result of [[force-feeding]]?
*...that the entire [[Kannada film industry]] participated in the '''[[Gokak agitation]]''' to demand the first language status of [[Kannada]]?
*...that '''[[Sunset Boulevard]]''' and '''[[Wilshire Boulevard]]''' both run from downtown to the sea?
*...that '''''[[Eyes of the Insane]]''''' by [[Slayer]] had two alternative endings filmed?
*[[Not bold at all]] — linha sem destaque.
*...that '''[[File:Foo.jpg]]''' is a picture?
*...that '''[[Curto]]'''?
`;

describe("parseDykHooks", () => {
  const hooks = parseDykHooks(ARQUIVO);
  const byTitle = new Map(hooks.map((h) => [h.title, h.hook]));

  it("extrai o artigo destacado de cada gancho", () => {
    expect(byTitle.has("Anne Lynch Botta")).toBe(true);
    expect(byTitle.has("Emil Calmanovici")).toBe(true);
    expect(byTitle.has("Gokak agitation")).toBe(true);
  });

  it("guarda o gancho limpo, sem o '...that' inicial", () => {
    expect(byTitle.get("Emil Calmanovici")).toBe(
      "Emil Calmanovici, the main financial backer of the Romanian Communist Party in the 1940s, was later imprisoned by Communist authorities and died as a result of force-feeding?",
    );
  });

  it("remove a legenda '(pictured)', que aponta para uma foto que não temos", () => {
    expect(byTitle.get("Anne Lynch Botta")).toBe(
      "Anne Lynch Botta introduced Edgar Allan Poe to literary society at her receptions?",
    );
  });

  it("ignora os links de contexto, que não são a entrada", () => {
    // 'Kannada film industry' e 'Edgar Allan Poe' aparecem, mas sem negrito.
    expect(byTitle.has("Kannada film industry")).toBe(false);
    expect(byTitle.has("Edgar Allan Poe")).toBe(false);
  });

  it("dá o mesmo gancho aos dois artigos quando ele destaca dois", () => {
    expect(byTitle.get("Sunset Boulevard")).toBe(byTitle.get("Wilshire Boulevard"));
    expect(byTitle.get("Sunset Boulevard")).toContain("run from downtown to the sea");
  });

  it("aceita negrito-itálico, usado para obras", () => {
    expect(byTitle.has("Eyes of the Insane")).toBe(true);
  });

  it("ignora linha sem nenhum destaque", () => {
    expect(byTitle.has("Not bold at all")).toBe(false);
  });

  it("ignora link para outro namespace", () => {
    expect(hooks.some((h) => h.title.startsWith("File:"))).toBe(false);
  });

  it("descarta gancho curto demais para valer como nota", () => {
    expect(byTitle.has("Curto")).toBe(false);
  });

  it("começa o gancho com maiúscula, para caber no card", () => {
    for (const h of hooks) expect(h.hook[0]).toBe(h.hook[0].toUpperCase());
  });

  it("não devolve nada para uma página sem ganchos", () => {
    expect(parseDykHooks("== Índice ==\nTexto solto, sem lista.")).toHaveLength(0);
  });
});
