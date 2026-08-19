import type { DB } from "./index";

export interface ArticleRecord {
  lang: string;
  pageId: number;
  title: string;
  url: string;
  extract?: string;
  thumbnailUrl?: string;
  curatorNote?: string;
  bytes?: number;
  source: string;
  sourceDetail?: string;
  curated: boolean;
}

/**
 * Grava um artigo. Reingestões preservam métricas e scores já calculados por
 * outras etapas da pipeline — só sobrescreve o que esta fonte de fato trouxe.
 */
export function upsertArticles(db: DB, rows: ArticleRecord[]): number {
  const stmt = db.prepare(`
    INSERT INTO articles (
      lang, page_id, title, url, extract, thumbnail_url, curator_note,
      bytes, source, source_detail, curated, updated_at
    ) VALUES (
      @lang, @pageId, @title, @url, @extract, @thumbnailUrl, @curatorNote,
      @bytes, @source, @sourceDetail, @curated, @updatedAt
    )
    ON CONFLICT (lang, page_id) DO UPDATE SET
      title         = excluded.title,
      url           = excluded.url,
      extract       = COALESCE(excluded.extract, articles.extract),
      thumbnail_url = COALESCE(excluded.thumbnail_url, articles.thumbnail_url),
      curator_note  = COALESCE(excluded.curator_note, articles.curator_note),
      bytes         = COALESCE(excluded.bytes, articles.bytes),
      -- Uma fonte curada nunca é rebaixada por uma varredura ampla posterior.
      source        = CASE WHEN articles.curated = 1 THEN articles.source
                          ELSE excluded.source END,
      source_detail = CASE WHEN articles.curated = 1 THEN articles.source_detail
                          ELSE excluded.source_detail END,
      curated       = MAX(articles.curated, excluded.curated),
      updated_at    = excluded.updated_at
  `);

  const updatedAt = new Date().toISOString();
  const run = db.transaction((batch: ArticleRecord[]) => {
    let n = 0;
    for (const r of batch) {
      stmt.run({
        lang: r.lang,
        pageId: r.pageId,
        title: r.title,
        url: r.url,
        extract: r.extract ?? null,
        thumbnailUrl: r.thumbnailUrl ?? null,
        curatorNote: r.curatorNote ?? null,
        bytes: r.bytes ?? null,
        source: r.source,
        sourceDetail: r.sourceDetail ?? null,
        curated: r.curated ? 1 : 0,
        updatedAt,
      });
      n++;
    }
    return n;
  });

  return run(rows);
}

export function startRun(db: DB, lang: string, source: string): number {
  const info = db
    .prepare(
      `INSERT INTO ingest_runs (lang, source, started_at) VALUES (?, ?, ?)`,
    )
    .run(lang, source, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishRun(
  db: DB,
  id: number,
  stats: { found: number; written: number; skipped: number; notes?: string },
): void {
  db.prepare(
    `UPDATE ingest_runs
        SET finished_at = ?, found = ?, written = ?, skipped = ?, notes = ?
      WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    stats.found,
    stats.written,
    stats.skipped,
    stats.notes ?? null,
    id,
  );
}
