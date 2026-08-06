import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SnapshotLedger, snapshotTreeHash, type SnapshotEntry } from "../src/snapshots/ledger";

function makeEntry(documentId = "doc-1", content = "한글"): SnapshotEntry {
  return { documentId, state: "fresh", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), content, provenance: "synthetic" };
}

function ledgerWithOne(): { ledger: SnapshotLedger; id: string; entry: SnapshotEntry } {
  const ledger = new SnapshotLedger();
  const entry = makeEntry();
  const pending = ledger.createPending({ policyDigest: "p".repeat(64), expectedCount: 1, expectedBytes: entry.bytes, expectedTreeHash: snapshotTreeHash([entry]) });
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
    const pending = ledger.createPending({ policyDigest: "p".repeat(64), expectedCount: 1, expectedBytes: entry.bytes, expectedTreeHash: snapshotTreeHash([entry]) });
    expect(() => ledger.addEntry(pending.id, { ...entry, sha256: "a".repeat(64) })).toThrow(/hash/);
    expect(() => ledger.addEntry(pending.id, { ...entry, bytes: 1 })).toThrow(/byte/);
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
    const second = first.ledger.createPending({ policyDigest: "p".repeat(64), expectedCount: 1, expectedBytes: secondEntry.bytes, expectedTreeHash: snapshotTreeHash([secondEntry]) });
    first.ledger.addEntry(second.id, secondEntry);
    first.ledger.finalize(second.id);
    expect(() => first.ledger.activate(second.id, null)).toThrow(/compare-and-swap/);
    expect(first.ledger.activate(second.id, 1).state).toBe("active");
    expect(first.ledger.get(first.id).state).toBe("finalized");
    expect(() => first.ledger.activate(first.id, 2)).toThrow(/immutable|finalized|monotonically/);
  });
});
