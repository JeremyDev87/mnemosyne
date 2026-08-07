import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestSigningIdentity, sha256, writeAttestedGeneration } from "../tests/helpers/signed-snapshot";

interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface E2eFixture {
  home: string;
  bin: string;
  documentBody: string;
  trustKeyId: string;
  trustPublicKey: string;
  trustAcceptedSequence: number;
  trustAcceptedAttestationId: string;
  command: string;
}

function packagedExecutable(): string {
  if (process.platform !== "darwin") throw new Error("Mnemosyne MVP packaging test requires macOS");
  return resolve("out-e2e", `Mnemosyne-E2E-UNSAFE-darwin-${process.arch}`, "Mnemosyne-E2E-UNSAFE.app", "Contents", "MacOS", "Mnemosyne-E2E-UNSAFE");
}

async function createFixture(): Promise<E2eFixture> {
  const home = await mkdtemp(join(tmpdir(), "mnemosyne-e2e-home-"));
  const bin = join(home, "bin");
  const stateRoot = join(home, ".hermes", "state", "wiki-retrieval");
  const generation = "20260807T000000Z-e2e";
  const documents = new Map([
    ["domains/personal-ops/fixture.md", "# Fixture document\n\nfixture-derived verified body"],
    ["brain/P6_prefrontal/personal-ops/tasks.md", "# Tasks\n\n- [ ] fixture task"],
    ["domains/personal-ops/schedule.md", "# Schedule\n\n- fixture schedule"],
    ["domains/personal-ops/inbox.md", "# Inbox\n\n- fixture inbox"]
  ]);
  const files = [...documents].map(([relative_path, content]) => {
    const bytes = Buffer.from(content);
    return { relative_path, size: bytes.byteLength, sha256: sha256(bytes), state: "copied" };
  });
  const manifest = { schema_version: 2, generation, created_at: "2026-08-07T00:00:00Z", file_count: files.length, files };
  const identity = createTestSigningIdentity(11);
  await mkdir(join(stateRoot, "snapshots", generation), { recursive: true });
  await Promise.all([...documents].map(async ([relativePath, content]) => {
    const path = join(stateRoot, "snapshots", generation, ...relativePath.split("/"));
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }));
  await writeAttestedGeneration({ root: stateRoot, generation, manifest, identity, sequence: 11 });

  await mkdir(bin, { recursive: true });
  const command = join(bin, "dobby-wiki");
  await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("health")) {
  process.stdout.write(JSON.stringify({ status: "ok", degraded: false, snapshot_state_counts: { copied: 4 } }));
} else if (args.includes("search")) {
  process.stdout.write(JSON.stringify({ status: "ok", degraded: false, results: [{ canonical_path: "domains/personal-ops/fixture.md", title: "Fixture document", domain: "personal-ops", source_role: "canonical", status: "current", do_not_answer_as_current: false }] }));
} else {
  process.exitCode = 2;
}
`);
  await chmod(command, 0o755);
  return {
    home,
    bin,
    documentBody: documents.get("domains/personal-ops/fixture.md")!,
    trustKeyId: identity.anchor.keyId,
    trustPublicKey: identity.anchor.publicKeyPem,
    trustAcceptedSequence: identity.anchor.acceptedSequence,
    trustAcceptedAttestationId: identity.anchor.acceptedAttestationId,
    command
  };
}

async function cdpTargets(port: number): Promise<CdpTarget[]> {
  return new Promise((resolveTargets, reject) => {
    const request = get({ hostname: "127.0.0.1", port, path: "/json/list", timeout: 1_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`CDP HTTP status ${response.statusCode}`));
        try { resolveTargets(JSON.parse(body) as CdpTarget[]); } catch (error) { reject(error); }
      });
    });
    request.once("timeout", () => request.destroy(new Error("CDP HTTP timeout")));
    request.once("error", reject);
  });
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a loopback port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForRendererTarget(port: number): Promise<CdpTarget> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const target = (await cdpTargets(port)).find((candidate) => candidate.type === "page" && candidate.url.startsWith("mnemosyne:"));
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Packaged app renderer CDP target was unavailable: ${String(lastError)}`);
}

async function cdpCommand<T>(target: CdpTarget, method: string, params: Record<string, unknown>): Promise<T> {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    return await new Promise<T>((resolveCommand, reject) => {
      const timeout = setTimeout(() => reject(new Error(`CDP command timed out: ${method}`)), 10_000);
      const finish = (callback: () => void): void => { clearTimeout(timeout); callback(); };
      socket.addEventListener("error", () => finish(() => reject(new Error(`CDP transport failed: ${method}`))), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })), { once: true });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: T; error?: { message?: string } };
        if (message.id !== 1) return;
        const errorMessage = message.error?.message;
        if (errorMessage) return finish(() => reject(new Error(`CDP ${method}: ${errorMessage}`)));
        finish(() => resolveCommand(message.result as T));
      });
    });
  } finally {
    socket.close();
  }
}

async function evaluate<T>(target: CdpTarget, expression: string): Promise<T> {
  const response = await cdpCommand<{ result?: { value?: T } }>(target, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.result?.value === undefined) throw new Error("CDP evaluation returned no serializable value");
  return response.result.value;
}

async function waitForRendererReady(port: number, readLogs: () => string): Promise<CdpTarget> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const target = await waitForRendererTarget(port);
      const ready = await evaluate<boolean>(target, "typeof window.mnemosyne?.health === 'function' && document.querySelector('h1')?.textContent === '오늘의 운영 상태'");
      if (ready) return target;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Packaged app renderer/preload was not ready: ${String(lastError)}\n${readLogs()}`);
}

async function stop(appProcess: ChildProcess): Promise<void> {
  if (appProcess.exitCode !== null || appProcess.killed) return;
  appProcess.kill("SIGTERM");
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => { appProcess.kill("SIGKILL"); resolveStop(); }, 5_000);
    appProcess.once("exit", () => { clearTimeout(timer); resolveStop(); });
  });
}

async function launchPackagedApp(executablePath: string, environment: NodeJS.ProcessEnv): Promise<{ appProcess: ChildProcess; target: CdpTarget; logs: () => string; userDataDir: string }> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = await reserveLoopbackPort();
    let appLogs = "";
    const userDataDir = await mkdtemp(join(tmpdir(), "mnemosyne-e2e-user-data-"));
    const appProcess = spawn(executablePath, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: environment
    });
    appProcess.stdout?.on("data", (chunk: Buffer) => { appLogs += chunk.toString(); });
    appProcess.stderr?.on("data", (chunk: Buffer) => { appLogs += chunk.toString(); });
    try {
      return { appProcess, target: await waitForRendererReady(port, () => appLogs), logs: () => appLogs, userDataDir };
    } catch (error) {
      lastFailure = error;
      await stop(appProcess);
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
  throw new Error(`Packaged app CDP launch failed after three fresh loopback ports: ${String(lastFailure)}`);
}


test("packaged app consumes an isolated verified fixture through only typed IPC", async ({ browserName }, testInfo) => {
  void browserName;
  const executablePath = packagedExecutable();
  await access(executablePath);
  const fixture = await createFixture();
  const launched = await launchPackagedApp(executablePath, {
    ...process.env,
    MNEMOSYNE_E2E_STATE_ROOT: join(fixture.home, ".hermes", "state", "wiki-retrieval"),
    MNEMOSYNE_E2E_TRUST_KEY_ID: fixture.trustKeyId,
    MNEMOSYNE_E2E_TRUST_PUBLIC_KEY: fixture.trustPublicKey,
    MNEMOSYNE_E2E_TRUST_ACCEPTED_SEQUENCE: String(fixture.trustAcceptedSequence),
    MNEMOSYNE_E2E_TRUST_ACCEPTED_ATTESTATION_ID: fixture.trustAcceptedAttestationId,
    MNEMOSYNE_E2E_DOBBY_COMMAND: fixture.command,
    ELECTRON_ENABLE_LOGGING: "1"
  });
  const { appProcess, target } = launched;

  try {
    const workflow = await evaluate<{
      health: { status: string; snapshotState: string; documentCount: number };
      ops: { tasks: { total: number }; schedule: { total: number }; inbox: { total: number } };
      search: { hits: Array<{ documentId: string; title: string }> };
      document: { body: string; title: string; documentId: string; authority: string };
      dashboardHeading?: string;
      requireType: string;
      processType: string;
      apiKeys: string[];
    }>(target, `
      (async () => {
        const health = await window.mnemosyne.health();
        const ops = await window.mnemosyne.personalOps();
        const search = await window.mnemosyne.search({ query: "fixture", limit: 1 });
        const loaded = await window.mnemosyne.getDocument({ documentId: search.hits[0].documentId });
        return { health, ops, search, document: loaded, dashboardHeading: window.document.querySelector("h1")?.textContent, requireType: typeof window.require, processType: typeof window.process, apiKeys: Object.keys(window.mnemosyne ?? {}).sort() };
      })()
    `);
    if (!workflow.health) throw new Error(`Fixture IPC workflow returned an incomplete value: ${JSON.stringify(workflow)}\n${launched.logs()}`);
    expect(workflow.health).toMatchObject({ status: "ok", snapshotState: "fresh", documentCount: 4 });
    expect(workflow.ops).toMatchObject({ tasks: { total: 0 }, schedule: { total: 0 }, inbox: { total: 0 } });
    expect(workflow.search.hits).toHaveLength(1);
    expect(workflow.search.hits[0]?.title).toBe("Fixture document");
    expect(workflow.document).toMatchObject({ title: "Fixture document", body: fixture.documentBody, authority: "canonical" });
    expect(workflow.document.documentId).toMatch(/^[a-f0-9]{64}$/u);
    expect({ dashboardHeading: workflow.dashboardHeading, requireType: workflow.requireType, processType: workflow.processType, apiKeys: workflow.apiKeys }).toEqual({
      dashboardHeading: "오늘의 운영 상태", requireType: "undefined", processType: "undefined", apiKeys: ["getDocument", "health", "personalOps", "search"]
    });
    const screenshot = await cdpCommand<{ data: string }>(target, "Page.captureScreenshot", { format: "png" });
    await writeFile(testInfo.outputPath("mnemosyne-dashboard.png"), Buffer.from(screenshot.data, "base64"));
  } finally {
    await stop(appProcess);
    await rm(fixture.home, { recursive: true, force: true });
    await rm(launched.userDataDir, { recursive: true, force: true });
  }
});
