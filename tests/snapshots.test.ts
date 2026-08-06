import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SnapshotLedger, snapshotTreeHash, type SnapshotEntry } from "../src/snapshots/ledger";

function makeEntry(documentId = "doc-1", content = "한글", relativePath = "domains/personal-ops/doc-1.md", provenance = "synthetic"): SnapshotEntry {
  return { documentId, relativePath, state: "fresh", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), content, provenance };
}

function ledgerWithOne(): { ledger: SnapshotLedger; id: string; entry: SnapshotEntry } {
  const ledger = new SnapshotLedger();
  const entry = makeEntry();
  const pending = ledger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: entry.bytes, expectedTreeHash: snapshotTreeHash([entry]) });
  ledger.addEntry(pending.id, entry);
  return { ledger, id: pending.id, entry };
}

describe("append-only snapshot ledger", () => {
  it("finalizes and activates a complete generation", () => {
    const { ledger, id } = ledgerWithOne();
    expect(ledger.finalize(id).state).toBe("finalized");
    expect(ledger.activate(id, null).state).toBe("active");
    expect(ledger.getActive()?.id).toBe(id);
  });
  it("rejects caller-supplied content hash and byte metadata tampering", () => {
    const ledger = new SnapshotLedger();
    const entry = makeEntry();
    const pending = ledger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: entry.bytes, expectedTreeHash: snapshotTreeHash([entry]) });
    expect(() => ledger.addEntry(pending.id, { ...entry, sha256: "a".repeat(64) })).toThrow(/hash/);
    expect(() => ledger.addEntry(pending.id, { ...entry, bytes: 1 })).toThrow(/byte/);
  });
  it("binds tree integrity to canonical path and provenance", () => {
    const entry = makeEntry();
    expect(snapshotTreeHash([entry])).not.toBe(snapshotTreeHash([{ ...entry, relativePath: "domains/personal-ops/other.md" }]));
    expect(snapshotTreeHash([entry])).not.toBe(snapshotTreeHash([{ ...entry, provenance: "icloud-wiki" }]));
    const ledger = new SnapshotLedger();
    const pending = ledger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: entry.bytes, expectedTreeHash: snapshotTreeHash([entry]) });
    expect(() => ledger.addEntry(pending.id, { ...entry, relativePath: "../raw.md" })).toThrow(/path/);
  });
  it("rejects duplicate relative paths across document IDs", () => {
    const ledger = new SnapshotLedger();
    const first = makeEntry("doc-1", "첫번째", "domains/personal-ops/shared.md");
    const second = makeEntry("doc-2", "두번째", "domains/personal-ops/shared.md");
    const pending = ledger.createPending({
      policyDigest: "a".repeat(64),
      expectedCount: 2,
      expectedBytes: first.bytes + second.bytes,
      expectedTreeHash: snapshotTreeHash([first, second])
    });
    ledger.addEntry(pending.id, first);
    expect(() => ledger.addEntry(pending.id, second)).toThrow(/duplicate snapshot relative path/);
  });
  it("rejects non-NFC path and provenance before hashing", () => {
    const pathEntry = makeEntry("doc-nfd-path", "x", "domains/personal-ops/cafe\u0301.md");
    const pathLedger = new SnapshotLedger();
    const pathPending = pathLedger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: pathEntry.bytes, expectedTreeHash: snapshotTreeHash([pathEntry]) });
    expect(() => pathLedger.addEntry(pathPending.id, pathEntry)).toThrow(/path/);

    const provenanceEntry = makeEntry("doc-nfd-provenance", "x", "domains/personal-ops/doc-nfd-provenance.md", "cafe\u0301-source");
    const provenanceLedger = new SnapshotLedger();
    const provenancePending = provenanceLedger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: provenanceEntry.bytes, expectedTreeHash: snapshotTreeHash([provenanceEntry]) });
    expect(() => provenanceLedger.addEntry(provenancePending.id, provenanceEntry)).toThrow(/provenance/);
  });
  it("protects internal state from returned-object mutation", () => {
    const { ledger, id, entry } = ledgerWithOne();
    const exposed = ledger.get(id) as unknown as { entries: SnapshotEntry[] };
    exposed.entries[0] = { ...entry, content: "tampered" };
    expect(ledger.get(id).entries[0]?.content).toBe(entry.content);
  });
  it("prevents delayed retry and rollback activation through CAS and monotonic sequence", () => {
    const first = ledgerWithOne();
    first.ledger.finalize(first.id);
    first.ledger.activate(first.id, null);
    const secondEntry = makeEntry("doc-2", "두번째");
    const second = first.ledger.createPending({ policyDigest: "a".repeat(64), expectedCount: 1, expectedBytes: secondEntry.bytes, expectedTreeHash: snapshotTreeHash([secondEntry]) });
    first.ledger.addEntry(second.id, secondEntry);
    first.ledger.finalize(second.id);
    expect(() => first.ledger.activate(second.id, null)).toThrow(/compare-and-swap/);
    expect(first.ledger.activate(second.id, 1).state).toBe("active");
    expect(first.ledger.get(first.id).state).toBe("finalized");
    expect(() => first.ledger.activate(first.id, 2)).toThrow(/immutable|finalized|monotonically/);
  });
});
