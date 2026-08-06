import { describe, expect, it } from "vitest";
import { searchSyntheticEntries } from "../src/search/synthetic";
import { privacySafeSearchTelemetry, snapshotUiState } from "../src/search/state";

describe("truthful read-only search state", () => {
  it("keeps snapshot lifecycle states distinct", () => {
    expect(snapshotUiState({ configured: false, active: false, entryCount: 0, hasStale: false, complete: false, rejected: false })).toBe("configuration-unavailable");
    expect(snapshotUiState({ configured: true, active: false, entryCount: 0, hasStale: false, complete: true, rejected: false })).toBe("no-active-snapshot");
    expect(snapshotUiState({ configured: true, active: true, entryCount: 0, hasStale: false, complete: true, rejected: false })).toBe("empty");
    expect(snapshotUiState({ configured: true, active: true, entryCount: 1, hasStale: true, complete: true, rejected: false })).toBe("stale");
    expect(snapshotUiState({ configured: true, active: true, entryCount: 1, hasStale: false, complete: false, rejected: false })).toBe("incomplete");
  });
  it("searches synthetic entries without exposing raw query telemetry", () => {
    const hits = searchSyntheticEntries([
      { documentId: "a", state: "fresh", sha256: "a".repeat(64), bytes: 5, content: "한국어 일정 정리", provenance: "synthetic" },
      { documentId: "b", state: "quarantined", sha256: "b".repeat(64), bytes: 5, content: "한국어 비공개", provenance: "synthetic" }
    ], "한국어 일정");
    expect(hits.map((hit) => hit.documentId)).toEqual(["a"]);
    expect(privacySafeSearchTelemetry("한국어 일정", hits.length)).toEqual({ queryLengthBucket: "4-12", resultCountBucket: "1-5" });
    expect(JSON.stringify(privacySafeSearchTelemetry("한국어 일정", hits.length))).not.toContain("한국어");
  });
});
