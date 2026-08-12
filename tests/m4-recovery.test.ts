import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ActivationCoordinator, type ActivationState } from "../src/wiki/activation-coordinator";

const roots: string[] = [];
const sha = (char: string) => char.repeat(64);

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-m4-"));
  roots.push(root);
  return root;
}

function crashAt(state: ActivationState): (observed: ActivationState) => never | void {
  return (observed) => {
    if (observed === state) throw new Error(`synthetic crash at ${state}`);
  };
}

function runWorker(root: string, generation: string, delayMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const worker = fileURLToPath(new URL("./m4-worker.ts", import.meta.url));
  return new Promise((resolve) => {
    const child = spawn(join(process.cwd(), "node_modules/.bin/vite-node"), [worker, root, generation, sha(generation === "gen-a" ? "a" : "b"), String(delayMs)], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("M4 crash/race/fork/drift recovery harness", () => {
  it.each<[ActivationState, string]>([
    ["prepared", "prepared_needs_attestation"],
    ["attested", "attested_needs_pointer_promotion"],
    ["pointer_promoted", "pointer_promoted_needs_verification"],
    ["verified", "verified_needs_cas_commit"]
  ])("recovers after a crash at %s", async (state, expectedVerdict) => {
    const root = await makeRoot();
    const candidate = { expectedGeneration: null, nextGeneration: "gen-a", attestationSha256: sha("a") };
    await expect(new ActivationCoordinator(root, { onBoundary: crashAt(state) }).activate(candidate)).rejects.toThrow(`synthetic crash at ${state}`);
    const coordinator = new ActivationCoordinator(root);
    expect((await coordinator.inspectRecovery()).verdict).toBe(expectedVerdict);
    await coordinator.resumeRecovered();
    expect((await coordinator.inspectRecovery()).verdict).toBe("complete");
  });

  it("serializes concurrent writers and rejects the loser without corrupting durable state", async () => {
    const root = await makeRoot();
    const [first, second] = await Promise.all([runWorker(root, "gen-a", 0), runWorker(root, "gen-b", 80)]);
    expect([first.code, second.code].filter((code) => code === 0)).toHaveLength(1);
    expect([first.code, second.code].filter((code) => code !== 0)).toHaveLength(1);
    const winner = first.code === 0 ? "gen-a" : "gen-b";
    const report = await new ActivationCoordinator(root).inspectRecovery();
    expect(report.verdict).toBe("complete");
    expect(report.pointer?.generation).toBe(winner);
    expect(report.cas?.generation).toBe(winner);
  });

  it("fails closed on forked pointer, CAS, and journal combinations", async () => {
    const root = await makeRoot();
    const coordinator = new ActivationCoordinator(root);
    await coordinator.activate({ expectedGeneration: null, nextGeneration: "gen-a", attestationSha256: sha("a") });
    await coordinator.clearCommittedJournal();
    await writeFile(coordinator.paths.pointerPath, JSON.stringify({ schema_version: 1, generation: "gen-b", attestation_sha256: sha("b") }));
    const report = await coordinator.inspectRecovery();
    expect(report.verdict).toBe("inconsistent_fail_closed");
    expect(report.pointer?.generation).toBe("gen-b");
    expect(report.cas?.generation).toBe("gen-a");
    await writeFile(coordinator.paths.journalPath, "{\"schema_version\":1,\"state\":\"verified\"}");
    expect((await coordinator.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");
  });

  it("detects post-promotion drift before CAS and preserves the old CAS", async () => {
    const root = await makeRoot();
    const baseline = new ActivationCoordinator(root);
    await baseline.activate({ expectedGeneration: null, nextGeneration: "gen-a", attestationSha256: sha("a") });
    const candidate = { expectedGeneration: "gen-a", nextGeneration: "gen-b", attestationSha256: sha("b") };
    const coordinator = new ActivationCoordinator(root, {
      onBoundary: async (state) => {
        if (state === "pointer_promoted") await writeFile(coordinator.paths.pointerPath, JSON.stringify({ schema_version: 1, generation: "gen-forged", attestation_sha256: sha("f") }));
      }
    });
    await expect(coordinator.activate(candidate)).rejects.toThrow();
    expect((await coordinator.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");
    expect((JSON.parse(await readFile(baseline.paths.casPath, "utf8")) as { generation: string }).generation).toBe("gen-a");
  });

  it("fails closed when a prepared journal is paired with baseline drift", async () => {
    const root = await makeRoot();
    const coordinator = new ActivationCoordinator(root, { onBoundary: crashAt("prepared") });
    await expect(coordinator.activate({ expectedGeneration: null, nextGeneration: "gen-a", attestationSha256: sha("a") })).rejects.toThrow();
    await writeFile(coordinator.paths.casPath, JSON.stringify({
      schema_version: 1,
      generation: "forged",
      attestation_sha256: sha("f"),
      operation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    }));
    expect((await coordinator.inspectRecovery()).verdict).toBe("inconsistent_fail_closed");
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
