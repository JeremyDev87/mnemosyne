import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ActivationConflictError,
  ActivationCoordinator,
  ActivationRecoveryError,
  type ActivationState
} from "../src/wiki/activation-coordinator";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function coordinator(onBoundary?: (state: ActivationState) => void | Promise<void>): Promise<ActivationCoordinator> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-activation-"));
  roots.push(root);
  return new ActivationCoordinator(root, { onBoundary });
}

const candidate = {
  expectedGeneration: null,
  nextGeneration: "gen-1",
  attestationSha256: "a".repeat(64)
} as const;

const crash = new Error("synthetic crash");

describe("durable pointer-first/CAS-second activation coordinator", () => {
  it("commits in the required order and can clear only a committed journal", async () => {
    const seen: ActivationState[] = [];
    const instance = await coordinator((state) => { seen.push(state); });
    const journal = await instance.activate(candidate, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(seen).toEqual(["prepared", "attested", "pointer_promoted", "verified", "cas_committed"]);
    expect(journal.state).toBe("cas_committed");
    expect((await instance.inspectRecovery()).verdict).toBe("complete");
    await instance.clearCommittedJournal();
    expect((await instance.inspectRecovery()).verdict).toBe("no_journal");
  });

  it.each([
    ["prepared", "prepared_needs_attestation"],
    ["attested", "attested_needs_pointer_promotion"],
    ["pointer_promoted", "pointer_promoted_needs_verification"],
    ["verified", "verified_needs_cas_commit"]
  ] as const)("classifies a crash after %s as %s", async (state, verdict) => {
    const instance = await coordinator((boundary) => {
      if (boundary === state) throw crash;
    });
    await expect(instance.activate(candidate)).rejects.toBe(crash);
    const report = await instance.inspectRecovery();
    expect(report.verdict).toBe(verdict);
    if (verdict === "verified_needs_cas_commit") {
      const committed = await instance.commitRecovered();
      expect(committed.state).toBe("cas_committed");
      expect((await instance.inspectRecovery()).verdict).toBe("complete");
    }
  });

  it("fails closed on pointer drift after promotion", async () => {
    const instance = await coordinator((state) => {
      if (state === "pointer_promoted") throw crash;
    });
    await expect(instance.activate(candidate)).rejects.toBe(crash);
    await writeFile(instance.paths.pointerPath, JSON.stringify({
      schema_version: 1,
      generation: "forged",
      attestation_sha256: "b".repeat(64)
    }));
    const report = await instance.inspectRecovery();
    expect(report.verdict).toBe("inconsistent_fail_closed");
    expect(report.reason).toMatch(/pointer/i);
    await expect(instance.commitRecovered()).rejects.toBeInstanceOf(ActivationRecoveryError);
  });

  it("fails closed on malformed journal and refuses concurrent writers", async () => {
    const instance = await coordinator();
    await writeFile(instance.paths.journalPath, "{not-json");
    const report = await instance.inspectRecovery();
    expect(report.verdict).toBe("inconsistent_fail_closed");

    await rm(instance.paths.journalPath, { force: true });
    await mkdir(instance.paths.lockPath);
    await writeFile(join(instance.paths.lockPath, "owner.json"), "held\n");
    await expect(instance.activate(candidate)).rejects.toBeInstanceOf(ActivationConflictError);
  });

  it("reclaims a lock owned by a dead process but never a live or malformed lock", async () => {
    const instance = await coordinator();
    await mkdir(instance.paths.lockPath);
    await writeFile(join(instance.paths.lockPath, "owner.json"), JSON.stringify({ schema_version: 1, pid: 99_999_999, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }) + "\n");
    await expect(instance.activate(candidate)).resolves.toMatchObject({ state: "cas_committed" });

    await instance.clearCommittedJournal();
    await mkdir(instance.paths.lockPath);
    await writeFile(join(instance.paths.lockPath, "owner.json"), JSON.stringify({ schema_version: 1, pid: process.pid, token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) + "\n");
    await expect(instance.activate({ ...candidate, expectedGeneration: "gen-1", nextGeneration: "gen-2" }))
      .rejects.toBeInstanceOf(ActivationConflictError);
  });

  it("fails closed when only one durable baseline exists or a completed record drifts", async () => {
    const instance = await coordinator();
    await writeFile(instance.paths.pointerPath, JSON.stringify({
      schema_version: 1,
      generation: "orphan",
      attestation_sha256: "d".repeat(64)
    }));
    expect((await instance.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");

    await rm(instance.paths.pointerPath, { force: true });
    await instance.activate(candidate, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const cas = JSON.parse(await readFile(instance.paths.casPath, "utf8")) as Record<string, unknown>;
    cas.attestation_sha256 = "e".repeat(64);
    await writeFile(instance.paths.casPath, JSON.stringify(cas));
    expect((await instance.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");
  });

  it("requires pointer and CAS to agree before starting a successor generation", async () => {
    const instance = await coordinator();
    await writeFile(instance.paths.pointerPath, JSON.stringify({
      schema_version: 1,
      generation: "old",
      attestation_sha256: "c".repeat(64)
    }));
    await expect(instance.activate(candidate)).rejects.toBeInstanceOf(ActivationConflictError);
    expect(await readFile(instance.paths.pointerPath, "utf8")).toContain("old");
  });
});
