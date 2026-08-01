import { parseWikiDocument, toFtsQuery } from "./authority";

export interface SearchResult {
  path: string;
  title: string;
  excerpt: string;
  authorityKind: string;
  authorityPriority: number;
  answerableAsCurrent: boolean;
  canonicalPath: string | null;
  status: string | null;
  sourceRole: string | null;
  lastVerified: string | null;
  score: number;
}

export async function indexDocument(db: D1Database, path: string, content: string, hash: string): Promise<void> {
  const document = parseWikiDocument(path, content);
  const metadata = document.metadata;
  await db.batch([
    db.prepare("DELETE FROM wiki_fts WHERE path = ?").bind(path),
    db.prepare(`INSERT INTO wiki_pages (
      path, title, body, hash, authority_kind, authority_priority, answerable_as_current,
      canonical_path, status, source_role, last_verified, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET title=excluded.title, body=excluded.body, hash=excluded.hash,
      authority_kind=excluded.authority_kind, authority_priority=excluded.authority_priority,
      answerable_as_current=excluded.answerable_as_current, canonical_path=excluded.canonical_path,
      status=excluded.status, source_role=excluded.source_role, last_verified=excluded.last_verified,
      indexed_at=excluded.indexed_at`).bind(
        path, document.title, document.body, hash, document.authority.kind, document.authority.priority,
        document.authority.answerableAsCurrent ? 1 : 0, document.authority.canonicalPath ?? null,
        typeof metadata.status === "string" ? metadata.status : null,
        typeof metadata.source_role === "string" ? metadata.source_role : null,
        typeof metadata.last_verified === "string" ? metadata.last_verified : null,
        new Date().toISOString()
      ),
    db.prepare("INSERT INTO wiki_fts (path, title, body) VALUES (?, ?, ?)").bind(path, document.title, document.body)
  ]);
}

export async function searchWiki(db: D1Database, rawQuery: string, limit = 10): Promise<SearchResult[]> {
  const query = toFtsQuery(rawQuery);
  if (!query) return [];
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const result = await db.prepare(`SELECT p.path, p.title,
    snippet(wiki_fts, 2, '<mark>', '</mark>', ' … ', 24) AS excerpt,
    p.authority_kind AS authorityKind, p.authority_priority AS authorityPriority,
    p.answerable_as_current AS answerableAsCurrent, p.canonical_path AS canonicalPath,
    p.status, p.source_role AS sourceRole, p.last_verified AS lastVerified,
    bm25(wiki_fts, 0.0, 4.0, 1.0) + (p.authority_priority / 100.0) AS score
    FROM wiki_fts JOIN wiki_pages p ON p.path = wiki_fts.path
    WHERE wiki_fts MATCH ?
    ORDER BY p.answerable_as_current DESC, p.authority_priority ASC, score ASC LIMIT ?`).bind(query, safeLimit).all();
  return (result.results as unknown as SearchResult[]).map((row) => ({ ...row, answerableAsCurrent: Boolean(row.answerableAsCurrent) }));
}
