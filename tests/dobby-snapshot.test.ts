import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinCurrentSnapshot, readPinnedDocument } from "../src/wiki/dobby-snapshot";
import { createTestSigningIdentity, sha256, writeAttestedGeneration } from "./helpers/signed-snapshot";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(state: "copied" | "stale" = "copied") {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-dobby-"));
  roots.push(root);
  const generation = "20260806T140839Z-test";
  const relativePath = "domains/personal-ops/sample.md";
  const content = "# 일정\n\n검증된 문서";
  const bytes = Buffer.from(content);
  const identity = createTestSigningIdentity(7);
  const entry = { relative_path: relativePath, sha256: sha256(bytes), size: bytes.byteLength, state };
  const manifest = { schema_version: 2, generation, created_at: "2026-08-06T05:09:00Z", file_count: 1, files: [entry] };
  await mkdir(join(root, "snapshots", generation, "domains", "personal-ops"), { recursive: true });
  await writeFile(join(root, "snapshots", generation, relativePath), bytes);
  await writeAttestedGeneration({ root, generation, manifest, identity, sequence: 7 });
  return { root, generation, relativePath, content, identity };
}

describe("pinned Dobby snapshot reader", () => {
  it("pins the one attested immutable generation and verifies document bytes", async () => {
    const value = await fixture();
    const pinned = await pinCurrentSnapshot(value.root, value.identity.anchor);
    expect(pinned.generationId).toBe(value.generation);
    expect(pinned.attestationSequence).toBe(7);
    await expect(readPinnedDocument(pinned, value.relativePath)).resolves.toBe(value.content);
  });

  it("rejects decomposed non-NFC manifest paths before a snapshot can be pinned", async () => {
    const value = await fixture();
    const decomposed = "domains/personal-ops/가.md";
    const bytes = Buffer.from("# non-NFC fixture");
    const entry = { relative_path: decomposed, sha256: sha256(bytes), size: bytes.byteLength, state: "copied" };
    const manifest = { schema_version: 2, generation: value.generation, created_at: "2026-08-06T05:09:00Z", file_count: 1, files: [entry] };
    await writeAttestedGeneration({ root: value.root, generation: value.generation, manifest, identity: value.identity, sequence: 8 });
    await expect(pinCurrentSnapshot(value.root, value.identity.anchor)).rejects.toThrow(/non-NFC/i);
  });

  it("rejects files that exceed pointer or document hard caps before parsing or hashing", async () => {
    const value = await fixture();
    await truncate(join(value.root, "current.json"), 64 * 1024 + 1);
    await expect(pinCurrentSnapshot(value.root, value.identity.anchor)).rejects.toThrow(/size limit/i);

    const documentTooLarge = await fixture();
    const pinned = await pinCurrentSnapshot(documentTooLarge.root, documentTooLarge.identity.anchor);
    await truncate(join(pinned.snapshotRoot, documentTooLarge.relativePath), 2 * 1024 * 1024 + 1);
    await expect(readPinnedDocument(pinned, documentTooLarge.relativePath)).rejects.toThrow(/size limit/i);
  });

  it("fails closed for stale entries, unsafe paths, and digest drift", async () => {
    const stale = await fixture("stale");
    const stalePin = await pinCurrentSnapshot(stale.root, stale.identity.anchor);
    await expect(readPinnedDocument(stalePin, stale.relativePath)).rejects.toThrow(/fresh|copied/i);
    await expect(readPinnedDocument(stalePin, "../private.md")).rejects.toThrow(/path/i);

    const drift = await fixture();
    const driftPin = await pinCurrentSnapshot(drift.root, drift.identity.anchor);
    await writeFile(join(driftPin.snapshotRoot, drift.relativePath), "drifted");
    await expect(readPinnedDocument(driftPin, drift.relativePath)).rejects.toThrow(/digest|size/i);
  });
});
