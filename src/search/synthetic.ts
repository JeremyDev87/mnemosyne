import { toFtsQuery } from "../wiki/authority";
import type { SnapshotEntry } from "../snapshots/ledger";

export interface SearchHit { documentId: string; score: number; excerpt: string }

export function searchSyntheticEntries(entries: readonly SnapshotEntry[], rawQuery: string, limit = 5): SearchHit[] {
  const query = rawQuery.normalize("NFC").trim();
  if (!query || !toFtsQuery(query)) return [];
  const tokens = query.toLocaleLowerCase("ko-KR").split(/\s+/u).filter(Boolean);
  return entries
    .filter((entry) => entry.state === "fresh" || entry.state === "stale")
    .map((entry) => {
      const haystack = entry.content.toLocaleLowerCase("ko-KR");
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      return { documentId: entry.documentId, score, excerpt: entry.content.slice(0, 160) };
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId, "en"))
    .slice(0, Math.max(1, Math.min(limit, 20)));
}
