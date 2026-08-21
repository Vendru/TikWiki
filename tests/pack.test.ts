import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/lib/db";
import { upsertArticles } from "../src/lib/db/articles";
import { packPool, packedPath, unpackPool } from "../src/lib/db/pack";

let dir: string;
let db: string;

const semear = () => {
  const h = openDb({ file: db });
  upsertArticles(h, [
    {
      lang: "en",
      pageId: 1,
      title: "Bir Tawil",
      url: "https://en.wikipedia.org/wiki/Bir_Tawil",
      extract: "Um território não reivindicado. ".repeat(50),
      source: "unusual",
      curated: true,
    },
  ]);
  h.close();
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-pack-"));
  db = path.join(dir, "pool.db");
  process.env.TIKWIKI_DB = db;
});

afterEach(() => {
  delete process.env.TIKWIKI_DB;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("packPool", () => {
  it("comprime e devolve os dois tamanhos", async () => {
    semear();
    const { cru, comprimido } = await packPool();
    expect(fs.existsSync(packedPath())).toBe(true);
    expect(comprimido).toBeLessThan(cru);
  });

  it("falha claro quando não existe pool para comprimir", async () => {
    await expect(packPool()).rejects.toThrow(/Pool não encontrado/);
  });

  it("não deixa arquivo temporário para trás", async () => {
    semear();
    await packPool();
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });
});

describe("unpackPool", () => {
  it("extrai um pool íntegro, que reabre e lê", async () => {
    semear();
    await packPool();
    fs.unlinkSync(db);

    expect(await unpackPool()).toBe("extraido");
    const h = openDb({ readonly: true, file: db });
    const row = h.prepare(`SELECT title FROM articles WHERE page_id = 1`).get() as {
      title: string;
    };
    h.close();
    expect(row.title).toBe("Bir Tawil");
  });

  it("não faz nada quando o cru já está em dia", async () => {
    semear();
    await packPool();
    // O cru é mais novo que o comprimido, então nada a extrair.
    expect(await unpackPool()).toBe("em-dia");
  });

  it("reextrai quando o comprimido é mais novo que o cru", async () => {
    semear();
    await packPool();
    const antigo = Date.now() / 1000 - 3600;
    fs.utimesSync(db, antigo, antigo);
    expect(await unpackPool()).toBe("extraido");
  });

  it("avisa quando não há pool nenhum, em vez de estourar", async () => {
    expect(await unpackPool()).toBe("ausente");
  });

  it("mantém o cru quando só ele existe", async () => {
    semear();
    expect(await unpackPool()).toBe("em-dia");
  });
});
