-- Pool de artigos. Read-only em produção; reescrito pela pipeline de ingestão.

CREATE TABLE IF NOT EXISTS articles (
  lang            TEXT    NOT NULL,
  page_id         INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  extract         TEXT,
  thumbnail_url   TEXT,
  -- Nota escrita à mão pelo curador da lista, quando a fonte tem uma.
  curator_note    TEXT,

  -- Métricas cruas. NULL = ainda não coletada (etapa 3 preenche o resto).
  bytes           INTEGER,
  langlinks       INTEGER,
  backlinks       INTEGER,
  refs            INTEGER,
  images          INTEGER,
  sections        INTEGER,
  pageviews       REAL,

  score_quality   REAL,
  score_surprise  REAL,

  -- Qual fonte trouxe o artigo, e o detalhe dentro dela (subpágina, categoria).
  source          TEXT    NOT NULL,
  source_detail   TEXT,
  -- Fontes curadas pulam o filtro de exclusão e recebem bônus de score.
  curated         INTEGER NOT NULL DEFAULT 0,

  topics          TEXT,
  updated_at      TEXT    NOT NULL,

  PRIMARY KEY (lang, page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS articles_lang_title ON articles (lang, title);
CREATE INDEX IF NOT EXISTS articles_quality  ON articles (lang, score_quality DESC);
CREATE INDEX IF NOT EXISTS articles_surprise ON articles (lang, score_surprise DESC);
CREATE INDEX IF NOT EXISTS articles_source   ON articles (lang, source);

CREATE TABLE IF NOT EXISTS topics (
  id    INTEGER PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_topics (
  lang     TEXT    NOT NULL,
  page_id  INTEGER NOT NULL,
  topic_id INTEGER NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  score    REAL,
  PRIMARY KEY (lang, page_id, topic_id)
);

CREATE INDEX IF NOT EXISTS article_topics_topic ON article_topics (topic_id, lang);

-- Registro de cada execução da pipeline, para saber a idade do pool.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lang        TEXT NOT NULL,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  found       INTEGER NOT NULL DEFAULT 0,
  written     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);
