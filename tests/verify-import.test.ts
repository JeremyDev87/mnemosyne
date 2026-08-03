import { describe, expect, it } from "vitest";
import { createRemoteImportManifest, type ImportManifest } from "../src/wiki/import-manifest";
import { verifyExactImport, verificationExitCode, type ExactImportVerificationInput } from "../scripts/verify-import";

const entries = [
  { path: "docs/a.md", size: 10, sha256: "a".repeat(64) },
  { path: "docs/b.md", size: 20, sha256: "b".repeat(64) }
];

const manifest: ImportManifest = {
  generatedAt: "2026-08-01T00:00:00.000Z",
  sourceRoot: "/Users/alice/Private Wiki",
  entries,
  totalBytes: 30,
  sourceRead: {
    discovered: 2,
    readable: 2,
    failed: 0,
    peakBufferedBytes: 20,
    hydration: { available: false, requested: 0, accepted: 0, failed: 0 },
    waves: [],
    finalErrorClasses: {}
  }
};

const schema = {
  objects: [
    { name: "wiki_pages", type: "table" },
    { name: "wiki_fts", type: "table" },
    { name: "index_status", type: "table" },
    { name: "wiki_pages_authority_idx", type: "index" }
  ],
  wikiPageColumns: [
    { name: "path", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "body", type: "TEXT" },
    { name: "hash", type: "TEXT" },
    { name: "authority_kind", type: "TEXT" },
    { name: "authority_priority", type: "INTEGER" },
    { name: "answerable_as_current", type: "INTEGER" },
    { name: "canonical_path", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "source_role", type: "TEXT" },
    { name: "last_verified", type: "TEXT" },
    { name: "indexed_at", type: "TEXT" }
  ],
  wikiFtsColumns: [
    { name: "path", type: "" },
    { name: "title", type: "" },
    { name: "body", type: "" }
  ],
  indexStatusColumns: [
    { name: "id", type: "INTEGER" },
    { name: "state", type: "TEXT" },
    { name: "document_count", type: "INTEGER" },
    { name: "manifest_hash", type: "TEXT" },
    { name: "updated_at", type: "TEXT" }
  ]
};

function normalInput(): ExactImportVerificationInput {
  const remoteManifest = createRemoteImportManifest(manifest);
  return {
    manifest,
    remoteManifest,
    r2Objects: entries.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
    d1: {
      ...schema,
      status: { state: "ready", documentCount: entries.length, manifestHash: remoteManifest.manifestHash },
      rows: entries.map((entry) => ({ path: entry.path, hash: entry.sha256 }))
    }
  };
}

describe("exact import verifier", () => {
  it("passes only a complete exact R2 and D1 projection", () => {
    const receipt = verifyExactImport(normalInput());

    expect(receipt.passed).toBe(true);
    expect(receipt.r2).toMatchObject({ expected: 2, matching: 2, missing: 0, stale: 0, extra: 0, exact: true });
    expect(receipt.d1).toMatchObject({
      schemaReady: true,
      indexState: "ready",
      expected: 2,
      matching: 2,
      missing: 0,
      stale: 0,
      extra: 0,
      exact: true
    });
  });

  it("fails when an expected R2 object is missing", () => {
    const input = normalInput();
    input.r2Objects = input.r2Objects.slice(0, 1);

    const receipt = verifyExactImport(input);
    expect(receipt.passed).toBe(false);
    expect(receipt.r2).toMatchObject({ matching: 1, missing: 1, stale: 0, extra: 0, exact: false });
  });

  it("fails on stale hashes and extra R2 objects or D1 rows", () => {
    const input = normalInput();
    input.r2Objects = [
      { ...input.r2Objects[0]!, sha256: "f".repeat(64) },
      input.r2Objects[1]!,
      { path: "stale/private-name.md", size: 5, sha256: "e".repeat(64) }
    ];
    input.d1.rows = [
      { ...input.d1.rows[0]!, hash: "f".repeat(64) },
      input.d1.rows[1]!,
      { path: "stale/private-name.md", hash: "e".repeat(64) }
    ];

    const receipt = verifyExactImport(input);
    expect(receipt.passed).toBe(false);
    expect(receipt.r2).toMatchObject({ missing: 0, stale: 1, extra: 1, exact: false });
    expect(receipt.d1).toMatchObject({ missing: 0, stale: 1, extra: 1, exact: false });
  });

  it("never passes a partial import even if the available projections match", () => {
    const input = normalInput();
    input.r2Objects = input.r2Objects.slice(0, 1);
    input.d1.status = { ...input.d1.status!, state: "indexing", documentCount: 1 };
    input.d1.rows = input.d1.rows.slice(0, 1);

    const receipt = verifyExactImport(input);
    expect(receipt.passed).toBe(false);
    expect(receipt.r2.exact).toBe(false);
    expect(receipt.d1).toMatchObject({ indexState: "indexing", missing: 1, exact: false });
  });

  it("never treats an exact R2 projection as a complete import when D1 is partial", () => {
    const input = normalInput();
    input.d1.rows = input.d1.rows.slice(0, 1);
    input.d1.status = { ...input.d1.status!, documentCount: 1 };

    const receipt = verifyExactImport(input);
    expect(receipt.r2.exact).toBe(true);
    expect(receipt.d1).toMatchObject({ matching: 1, missing: 1, countReady: false, exact: false });
    expect(receipt.passed).toBe(false);
  });

  it("fails closed on remote manifest, D1 schema, status count, or status hash drift", () => {
    const input = normalInput();
    input.remoteManifest = { ...input.remoteManifest!, totalBytes: 31 };
    input.d1.objects = input.d1.objects.filter((object) => object.name !== "wiki_pages_authority_idx");
    input.d1.status = { state: "ready", documentCount: 99, manifestHash: "f".repeat(64) };

    const receipt = verifyExactImport(input);
    expect(receipt.manifest.exact).toBe(false);
    expect(receipt.r2.exact).toBe(true);
    expect(receipt.d1).toMatchObject({
      schemaReady: false,
      indexState: "ready",
      countReady: false,
      manifestReady: false,
      exact: false
    });
    expect(receipt.passed).toBe(false);
  });

  it("keeps aggregate receipts and exit codes deterministic across observation order", () => {
    const first = normalInput();
    const second = normalInput();
    second.r2Objects.reverse();
    second.d1.rows.reverse();
    second.d1.objects.reverse();
    second.d1.wikiPageColumns.reverse();

    const firstReceipt = verifyExactImport(first);
    const secondReceipt = verifyExactImport(second);
    expect(secondReceipt).toEqual(firstReceipt);
    expect(verificationExitCode(firstReceipt)).toBe(0);
    expect(verificationExitCode({ passed: false })).toBe(1);
    expect(Object.keys(firstReceipt)).toEqual(["version", "state", "passed", "manifest", "r2", "d1"]);
  });

  it("emits only privacy-safe aggregate evidence", () => {
    const input = normalInput();
    input.r2Objects.push({ path: "stale/private-name.md", size: 1, sha256: "0".repeat(64) });
    input.d1.rows.push({ path: "stale/private-name.md", hash: "0".repeat(64) });
    input.remoteManifest = { ...input.remoteManifest!, manifestHash: "super-secret-token" };

    const receipt = verifyExactImport(input);
    expect(receipt.manifest.remoteHash).toBeNull();
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      manifest.sourceRoot,
      "docs/a.md",
      "docs/b.md",
      "stale/private-name.md",
      "PRIVATE_CONTENT_SENTINEL",
      "secret query",
      "user@example.com",
      "super-secret-token"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("query");
    expect(serialized).not.toContain("identity");
    expect(serialized).not.toContain("secret");
  });
});
