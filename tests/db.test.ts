import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DB, openDb } from "../src/lib/db";
import { type ArticleRecord, upsertArticles } from "../src/lib/db/articles";

let db: DB;
let dir: string;

const base: ArticleRecord = {
  lang: "en",
  pageId: 1,
  title: "Bir Tawil",
  url: "https://en.wikipedia.org/wiki/Bir_Tawil",
  source: "unusual",
  curated: true,
};

const row = () =>
  db.prepare(`SELECT * FROM articles WHERE lang = 'en' AND page_id = 1`).get() as
    | Record<string, unknown>
    | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-"));
  db = openDb({ file: path.join(dir, "test.db") });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("upsertArticles", () => {
  it("insere e conta as linhas gravadas", () => {
    expect(upsertArticles(db, [base])).toBe(1);
    expect(row()?.title).toBe("Bir Tawil");
  });

  it("preserva scores calculados por outra etapa da pipeline", () => {
    upsertArticles(db, [base]);
    db.prepare(
      `UPDATE articles SET score_quality = 9.5, pageviews = 120 WHERE page_id = 1`,
    ).run();

    upsertArticles(db, [{ ...base, title: "Bir Tawil (novo)" }]);

    expect(row()?.score_quality).toBe(9.5);
    expect(row()?.pageviews).toBe(120);
    expect(row()?.title).toBe("Bir Tawil (novo)");
  });

  it("não apaga extract e nota quando a fonte nova não os traz", () => {
    upsertArticles(db, [{ ...base, extract: "resumo", curatorNote: "nota" }]);
    upsertArticles(db, [base]);

    expect(row()?.extract).toBe("resumo");
    expect(row()?.curator_note).toBe("nota");
  });

  it("uma varredura ampla não rebaixa um artigo curado", () => {
    upsertArticles(db, [base]);
    upsertArticles(db, [{ ...base, source: "random", curated: false }]);

    expect(row()?.source).toBe("unusual");
    expect(row()?.curated).toBe(1);
  });

  it("uma fonte curada promove um artigo já visto na varredura", () => {
    upsertArticles(db, [{ ...base, source: "random", curated: false }]);
    upsertArticles(db, [base]);

    expect(row()?.source).toBe("unusual");
    expect(row()?.curated).toBe(1);
  });

  it("mantém idiomas separados sob o mesmo page_id", () => {
    upsertArticles(db, [base, { ...base, lang: "pt", title: "Bir Tawil (pt)" }]);
    const n = db.prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("recusa dois artigos com o mesmo título no mesmo idioma", () => {
    upsertArticles(db, [base]);
    expect(() => upsertArticles(db, [{ ...base, pageId: 2 }])).toThrow();
  });

  it("grava o lote inteiro ou nada", () => {
    const bad = [
      { ...base, pageId: 10, title: "A" },
      { ...base, pageId: 11, title: "A" }, // colide no índice único
    ];
    expect(() => upsertArticles(db, bad)).toThrow();
    const n = db.prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("upsertArticles — a nota da fonte curada", () => {
  it("não deixa outra fonte sobrescrever a nota de quem chegou primeiro", () => {
    // Bug real: 129 artigos da lista peculiar tiveram a piada do curador
    // trocada pelo gancho do "Você sabia?" porque estavam nas duas fontes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tikwiki-nota-"));
    const db = openDb({ file: path.join(dir, "n.db") });

    const base = {
      lang: "en",
      pageId: 1,
      title: "Salish Sea human foot discoveries",
      url: "https://en.wikipedia.org/wiki/S",
    };
    upsertArticles(db, [
      { ...base, source: "unusual", curated: true, curatorNote: "Severed feet keep washing up." },
    ]);
    upsertArticles(db, [
      { ...base, source: "dyk", curated: true, curatorNote: "Five detached human feet have been discovered?" },
    ]);

    const r = db.prepare(`SELECT curator_note n, source s FROM articles WHERE page_id = 1`).get() as {
      n: string;
      s: string;
    };
    expect(r.n).toBe("Severed feet keep washing up.");
    expect(r.s).toBe("unusual");

    // A mesma fonte reingerindo continua podendo corrigir a nota.
    upsertArticles(db, [
      { ...base, source: "unusual", curated: true, curatorNote: "Severed feet keep washing up, plural." },
    ]);
    expect(
      (db.prepare(`SELECT curator_note n FROM articles WHERE page_id = 1`).get() as { n: string }).n,
    ).toBe("Severed feet keep washing up, plural.");

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
