import { describe, expect, it } from "vitest";
import { searchSyntheticEntries } from "../src/search/synthetic";
import type { SnapshotEntry } from "../src/snapshots/ledger";

const golden = [
  ["일정", "doc-01"], ["업무", "doc-02"], ["회의", "doc-03"], ["인박스", "doc-04"], ["배포", "doc-05"],
  ["문서", "doc-06"], ["리뷰", "doc-07"], ["테스트", "doc-08"], ["계약", "doc-09"], ["동기화", "doc-10"],
  ["개인정보", "doc-11"], ["권한", "doc-12"], ["검색", "doc-13"], ["스냅샷", "doc-14"], ["백업", "doc-15"],
  ["작업", "doc-16"], ["상태", "doc-17"], ["보류", "doc-18"], ["완료", "doc-19"], ["다음 액션", "doc-20"]
] as const;

const entries: SnapshotEntry[] = golden.map(([query, documentId]) => ({ documentId, state: "fresh", sha256: "a".repeat(64), bytes: Buffer.byteLength(query), content: `${query} 개인 운영 기록`, provenance: "synthetic" }));

describe("Korean search golden benchmark", () => {
  it("keeps top-5 recall at 0.90 or better on 20 synthetic queries", () => {
    const hits = golden.map(([query, expected]) => searchSyntheticEntries(entries, query, 5).some((hit) => hit.documentId === expected));
    const recall = hits.filter(Boolean).length / golden.length;
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});
