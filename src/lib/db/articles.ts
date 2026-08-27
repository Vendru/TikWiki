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
  langlinks?: number;
  backlinks?: number;
  refs?: number;
  images?: number;
  sections?: number;
  pageviews?: number;
  scoreQuality?: number;
  scoreSurprise?: number;
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
      bytes, langlinks, backlinks, refs, images, sections, pageviews,
      score_quality, score_surprise,
      source, source_detail, curated, updated_at
    ) VALUES (
      @lang, @pageId, @title, @url, @extract, @thumbnailUrl, @curatorNote,
      @bytes, @langlinks, @backlinks, @refs, @images, @sections, @pageviews,
      @scoreQuality, @scoreSurprise,
      @source, @sourceDetail, @curated, @updatedAt
    )
    ON CONFLICT (lang, page_id) DO UPDATE SET
      title         = excluded.title,
      url           = excluded.url,
      extract       = COALESCE(excluded.extract, articles.extract),
      thumbnail_url = COALESCE(excluded.thumbnail_url, articles.thumbnail_url),
      -- A nota é protegida como o source: a primeira fonte curada a reivindicar
      -- o artigo fica dona dela. Sem isso o gancho do "Você sabia?" sobrescrevia
      -- a piada do curador da lista peculiar sempre que o artigo estava nas
      -- duas — 129 artigos, e é o melhor conteúdo do pool que se perdia.
      -- A mesma fonte reingerindo continua atualizando a nota.
      curator_note  = CASE
                        WHEN articles.curated = 1 AND articles.source <> excluded.source
                          THEN COALESCE(articles.curator_note, excluded.curator_note)
                        ELSE COALESCE(excluded.curator_note, articles.curator_note)
                      END,
      bytes         = COALESCE(excluded.bytes, articles.bytes),
      langlinks     = COALESCE(excluded.langlinks, articles.langlinks),
      backlinks     = COALESCE(excluded.backlinks, articles.backlinks),
      refs          = COALESCE(excluded.refs, articles.refs),
      images        = COALESCE(excluded.images, articles.images),
      sections      = COALESCE(excluded.sections, articles.sections),
      pageviews     = COALESCE(excluded.pageviews, articles.pageviews),
      score_quality  = COALESCE(excluded.score_quality, articles.score_quality),
      score_surprise = COALESCE(excluded.score_surprise, articles.score_surprise),
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
        langlinks: r.langlinks ?? null,
        backlinks: r.backlinks ?? null,
        refs: r.refs ?? null,
        images: r.images ?? null,
        sections: r.sections ?? null,
        pageviews: r.pageviews ?? null,
        scoreQuality: r.scoreQuality ?? null,
        scoreSurprise: r.scoreSurprise ?? null,
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
