import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DB, openDb } from "../src/lib/db";
import { upsertArticles } from "../src/lib/db/articles";

// server-only lança fora de um componente de servidor; no teste é ruído.
vi.mock("server-only", () => ({}));

let dir: string;
let dbFile: string;
let seed: DB;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-pool-"));
  dbFile = path.join(dir, "pool.db");
  seed = openDb({ file: dbFile });
  upsertArticles(
    seed,
    Array.from({ length: 30 }, (_, i) => ({
      lang: "en",
      pageId: i + 1,
      title: `Artigo ${i + 1}`,
      url: `https://en.wikipedia.org/wiki/A${i + 1}`,
      extract: `resumo ${i + 1}`,
      curatorNote: i % 2 === 0 ? `nota ${i + 1}` : undefined,
      source: "unusual",
      curated: true,
    })),
  );
  seed.close();
  process.env.TIKWIKI_DB = dbFile;
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const load = async () => import("../src/lib/db/pool");

describe("randomArticle", () => {
  it("devolve um artigo com os campos que a UI usa", async () => {
    const { randomArticle } = await load();
    const a = randomArticle({ lang: "en" });
    expect(a).toBeDefined();
    expect(a!.title).toMatch(/^Artigo \d+$/);
    expect(a!.url).toContain("wikipedia.org");
    expect(a!.extract).toMatch(/^resumo/);
  });

  it("nunca devolve um artigo da lista de exclusão", async () => {
    const { randomArticle } = await load();
    const exclude = Array.from({ length: 29 }, (_, i) => i + 1); // sobra o 30
    for (let i = 0; i < 25; i++) {
      expect(randomArticle({ lang: "en", exclude })!.pageId).toBe(30);
    }
  });

  it("volta a sortear do pool inteiro quando tudo já foi visto", async () => {
    const { randomArticle } = await load();
    const todos = Array.from({ length: 30 }, (_, i) => i + 1);
    // Repetir é melhor que devolver nada quando o usuário exauriu o pool.
    expect(randomArticle({ lang: "en", exclude: todos })).toBeDefined();
  });

  it("ignora valores não inteiros na exclusão sem quebrar o SQL", async () => {
    const { randomArticle } = await load();
    const sujo = [1, Number.NaN, 2.5, 3] as number[];
    expect(randomArticle({ lang: "en", exclude: sujo })).toBeDefined();
  });

  it("limita a exclusão para não montar uma query sem teto", async () => {
    const { randomArticle } = await load();
    const enorme = Array.from({ length: 5000 }, (_, i) => i + 1000);
    expect(randomArticle({ lang: "en", exclude: enorme })).toBeDefined();
  });

  it("não devolve artigo de outro idioma", async () => {
    const { randomArticle } = await load();
    expect(randomArticle({ lang: "pt" })).toBeUndefined();
  });

  it("varre o pool ao longo de muitos sorteios", async () => {
    const { randomArticle } = await load();
    const vistos = new Set<number>();
    for (let i = 0; i < 400; i++) vistos.add(randomArticle({ lang: "en" })!.pageId);
    // Uniforme de verdade cobre as 30 em 400 tentativas com folga enorme.
    expect(vistos.size).toBeGreaterThan(25);
  });
});

describe("randomArticle — sorteio por rowid", () => {
  it("continua uniforme com buracos no rowid deixados por remoções", async () => {
    // O sorteio usa rowid; remover linhas abre buracos, e um 'rowid >= ?'
    // favoreceria quem vem logo depois de cada buraco.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-gaps-"));
    const file = path.join(dir2, "gaps.db");
    const seed2 = openDb({ file });
    upsertArticles(
      seed2,
      Array.from({ length: 60 }, (_, i) => ({
        lang: "en",
        pageId: i + 1,
        title: `G${i + 1}`,
        url: `https://en.wikipedia.org/wiki/G${i + 1}`,
        source: "unusual",
        curated: true,
      })),
    );
    // Deixa só os pares: metade da faixa de rowid vira buraco.
    seed2.prepare(`DELETE FROM articles WHERE page_id % 2 = 1`).run();
    seed2.close();

    process.env.TIKWIKI_DB = file;
    vi.resetModules();
    const { randomArticle } = await import("../src/lib/db/pool");

    const contagem = new Map<number, number>();
    for (let i = 0; i < 3000; i++) {
      const a = randomArticle({ lang: "en" });
      expect(a).toBeDefined();
      contagem.set(a!.pageId, (contagem.get(a!.pageId) ?? 0) + 1);
    }

    expect(contagem.size).toBe(30);
    // Uniforme daria 100 por artigo; a folga cobre a variação aleatória.
    const valores = [...contagem.values()];
    expect(Math.min(...valores)).toBeGreaterThan(45);
    expect(Math.max(...valores)).toBeLessThan(180);

    process.env.TIKWIKI_DB = dbFile;
    vi.resetModules();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});

describe("randomArticle — filtro de tema", () => {
  it("continua respeitando o peso por fonte", async () => {
    // Regressão real: o caminho do tema ignorava a escolha de fonte, e a
    // lista peculiar caía de 58% para 8% assim que o usuário filtrava.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-tema-"));
    const file = path.join(dir2, "tema.db");
    const seed2 = openDb({ file });

    // Fonte curada minúscula contra uma fonte grande, que é a situação real.
    upsertArticles(seed2, [
      ...Array.from({ length: 5 }, (_, i) => ({
        lang: "en",
        pageId: i + 1,
        title: `Peculiar ${i + 1}`,
        url: `https://en.wikipedia.org/wiki/P${i + 1}`,
        source: "unusual",
        curated: true,
      })),
      ...Array.from({ length: 500 }, (_, i) => ({
        lang: "en",
        pageId: 1000 + i,
        title: `Sabia ${i}`,
        url: `https://en.wikipedia.org/wiki/S${i}`,
        source: "dyk",
        curated: true,
      })),
    ]);

    seed2.prepare(`INSERT INTO topics (id, slug, label) VALUES (1, 'tema', 'Tema')`).run();
    const vincula = seed2.prepare(
      `INSERT INTO article_topics (lang, page_id, topic_id, score) VALUES ('en', ?, 1, 1)`,
    );
    const ordena = seed2.prepare(
      `INSERT INTO topic_index (lang, topic_id, source, ord, page_id) VALUES ('en', 1, ?, ?, ?)`,
    );
    for (let i = 0; i < 5; i++) {
      vincula.run(i + 1);
      ordena.run("unusual", i, i + 1);
    }
    for (let i = 0; i < 500; i++) {
      vincula.run(1000 + i);
      ordena.run("dyk", i, 1000 + i);
    }
    seed2.close();

    process.env.TIKWIKI_DB = file;
    vi.resetModules();
    const { randomArticle } = await import("../src/lib/db/pool");

    const porFonte = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const a = randomArticle({ lang: "en", topic: "tema" })!;
      porFonte.set(a.source, (porFonte.get(a.source) ?? 0) + 1);
    }

    // A fonte curada é 1% dos artigos do tema; sem a ponderação apareceria
    // nessa proporção. Com ela, tem que passar de um terço.
    expect(porFonte.get("unusual")! / 600).toBeGreaterThan(0.33);

    process.env.TIKWIKI_DB = dbFile;
    vi.resetModules();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it("devolve undefined para tema que não existe", async () => {
    const { randomArticle } = await load();
    expect(randomArticle({ lang: "en", topic: "inexistente" })).toBeUndefined();
  });
});

describe("poolSize", () => {
  it("conta apenas o idioma pedido", async () => {
    const { poolSize } = await load();
    expect(poolSize("en")).toBe(30);
    expect(poolSize("pt")).toBe(0);
  });
});
