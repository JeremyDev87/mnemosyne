CREATE TABLE IF NOT EXISTS wiki_pages (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  hash TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  authority_priority INTEGER NOT NULL,
  answerable_as_current INTEGER NOT NULL CHECK (answerable_as_current IN (0, 1)),
  canonical_path TEXT,
  status TEXT,
  source_role TEXT,
  last_verified TEXT,
  indexed_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS index_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('empty', 'indexing', 'ready', 'error')),
  document_count INTEGER NOT NULL DEFAULT 0,
  manifest_hash TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO index_status (id, state, document_count, updated_at)
VALUES (1, 'empty', 0, datetime('now'));

CREATE INDEX IF NOT EXISTS wiki_pages_authority_idx
ON wiki_pages(answerable_as_current, authority_priority, path);
