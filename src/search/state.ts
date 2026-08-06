export type SnapshotUiState = "configuration-unavailable" | "no-active-snapshot" | "empty" | "fresh" | "stale" | "incomplete" | "rejected";

export interface SnapshotUiInput { configured: boolean; active: boolean; entryCount: number; hasStale: boolean; complete: boolean; rejected: boolean }

export function snapshotUiState(input: SnapshotUiInput): SnapshotUiState {
  if (!input.configured) return "configuration-unavailable";
  if (input.rejected) return "rejected";
  if (!input.active) return "no-active-snapshot";
  if (!input.complete) return "incomplete";
  if (input.entryCount === 0) return "empty";
  if (input.hasStale) return "stale";
  return "fresh";
}

export function privacySafeSearchTelemetry(rawQuery: string, resultCount: number): { queryLengthBucket: string; resultCountBucket: string } {
  const length = rawQuery.normalize("NFC").length;
  const queryLengthBucket = length === 0 ? "0" : length <= 3 ? "1-3" : length <= 12 ? "4-12" : "13+";
  const resultCountBucket = resultCount === 0 ? "0" : resultCount <= 5 ? "1-5" : resultCount <= 20 ? "6-20" : "21+";
  return { queryLengthBucket, resultCountBucket };
}
