import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DobbyWikiAdapter, buildVerifiedExcerpt } from "../src/wiki/dobby-adapter";
import { createTestSigningIdentity, sha256, writeAttestedGeneration } from "./helpers/signed-snapshot";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("verified search excerpts", () => {
  it("normalizes whitespace and applies the bounded length to an already parsed body", () => {
    expect(buildVerifiedExcerpt("# 제목\n\n검증된\t본문")).toBe("# 제목 검증된 본문");
    expect(buildVerifiedExcerpt("  \n  \t본문  ")).toBe("본문");
    expect(buildVerifiedExcerpt("x".repeat(501))).toHaveLength(500);
    expect(buildVerifiedExcerpt("", 0)).toBe("");
  });
});

async function stateFixture() {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-adapter-"));
  roots.push(root);
  const generation = "20260806T140839Z-adapter";
  const relativePath = "domains/personal-ops/sample.md";
  const content = "---\nauthority: current\nstatus: active\n---\n# 오늘 일정\n\n검증된 본문";
  const bytes = Buffer.from(content);
  const identity = createTestSigningIdentity(3);
  const entry = { relative_path: relativePath, sha256: sha256(bytes), size: bytes.byteLength, state: "copied" };
  const manifest = { schema_version: 2, generation, created_at: "2026-08-06T05:09:00Z", file_count: 1, files: [entry] };
  await mkdir(join(root, "snapshots", generation, "domains", "personal-ops"), { recursive: true });
  await writeFile(join(root, "snapshots", generation, relativePath), bytes);
  await writeAttestedGeneration({ root, generation, manifest, identity, sequence: 3 });
  return { root, relativePath, anchor: identity.anchor };
}

describe("Dobby read-only adapter", () => {
  it("returns opaque search IDs and reads only the attested pinned document", async () => {
    const fixture = await stateFixture();
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("health")) return { status: "ok", degraded: false, snapshot_state_counts: { copied: 1 } };
      return {
        status: "ok",
        degraded: false,
        results: [{
          canonical_path: fixture.relativePath,
          path: fixture.relativePath,
          title: "FORGED CLI TITLE",
          domain: "forged-domain",
          source_role: "forged-role",
          status: "obsolete",
          do_not_answer_as_current: true
        }]
      };
    });
    const adapter = new DobbyWikiAdapter({ stateRoot: fixture.root, trustAnchor: fixture.anchor, command: "/trusted/dobby-wiki", runCommand });

    await expect(adapter.health()).resolves.toMatchObject({ status: "ok", snapshotState: "fresh", documentCount: 1 });
    const search = await adapter.search({ query: "일정", limit: 5 });
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]?.documentId).toMatch(/^[a-f0-9]{64}$/u);
    expect(search.hits[0]).toMatchObject({ title: "오늘 일정", domain: "personal-ops", authority: "current", excerpt: "# 오늘 일정 검증된 본문" });
    expect(JSON.stringify(search)).not.toContain(fixture.relativePath);
    expect(JSON.stringify(search)).not.toContain("FORGED CLI TITLE");
    expect(JSON.stringify(search)).not.toContain("authority: current");

    const document = await adapter.getDocument({ documentId: search.hits[0]!.documentId });
    expect(document).toMatchObject({ title: "오늘 일정", authority: "current" });
    expect(document.body).toContain("검증된 본문");
  });

  it("fails closed without a trust anchor, redacts command failures, and rejects unknown opaque IDs", async () => {
    const fixture = await stateFixture();
    const runCommand = vi.fn(async () => { throw new Error("must not execute"); });
    const adapter = new DobbyWikiAdapter({
      stateRoot: fixture.root,
      runCommand
    });
    const health = await adapter.health();
    expect(health.status).toBe("unavailable");
    expect(JSON.stringify(health)).not.toContain("private");
    expect(runCommand).not.toHaveBeenCalled();
    await expect(adapter.getDocument({ documentId: "b".repeat(64) })).rejects.toThrow(/unknown document/i);
  });
});
