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

describe("poolSize", () => {
  it("conta apenas o idioma pedido", async () => {
    const { poolSize } = await load();
    expect(poolSize("en")).toBe(30);
    expect(poolSize("pt")).toBe(0);
  });
});
