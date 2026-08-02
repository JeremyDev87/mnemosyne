import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface HydrationReceipt {
  available: boolean;
  requested: number;
  accepted: number;
  failed: number;
}

export interface SourceReadWaveReceipt {
  wave: number;
  attempted: number;
  succeeded: number;
  retryable: number;
  terminal: number;
  errorClasses: Record<string, number>;
  durationMs: number;
}

export interface SourceReadReceipt {
  discovered: number;
  readable: number;
  failed: number;
  hydration: HydrationReceipt;
  waves: SourceReadWaveReceipt[];
  finalErrorClasses: Record<string, number>;
}

export interface SourceReaderOptions {
  read?: (path: string, signal: AbortSignal) => Promise<Buffer>;
  hydrate?: (paths: string[]) => Promise<Omit<HydrationReceipt, "available"> & { available?: boolean }>;
  sleep?: (milliseconds: number) => Promise<void>;
  maxWaves?: number;
  timeoutMs?: number;
  batchDelayMs?: number;
  concurrency?: number;
}

export class SourceReadError extends Error {
  constructor(public readonly receipt: SourceReadReceipt) {
    super(`Source scan failed closed: ${receipt.failed} unreadable file(s); errors=${JSON.stringify(receipt.finalErrorClasses)}`);
    this.name = "SourceReadError";
  }
}

interface FailedRead { path: string; errorClass: string; retryable: boolean }
type ReadResult = { path: string; bytes: Buffer; failure?: never } | { path: string; bytes?: never; failure: FailedRead };

const RETRYABLE_CODES = new Set(["EAGAIN", "EDEADLK", "EBUSY", "ENOENT", "ABORT_ERR", "AbortError", "TimeoutError"]);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorClass(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown; errno?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    if (typeof candidate.name === "string") return candidate.name;
    if (candidate.errno !== undefined) return String(candidate.errno);
  }
  return "UNKNOWN";
}

function isRetryableReadError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown; errno?: unknown };
    if (candidate.errno === -11) return true;
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return RETRYABLE_CODES.has(code) || RETRYABLE_CODES.has(name) || code.includes("-11");
  }
  return false;
}

function countClasses(failures: FailedRead[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of failures) counts[failure.errorClass] = (counts[failure.errorClass] ?? 0) + 1;
  return counts;
}

function requestHydration(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/brctl", ["download", path], { stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 10_000);
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

async function hydrateOnMac(paths: string[]): Promise<HydrationReceipt> {
  if (process.platform !== "darwin") return { available: false, requested: paths.length, accepted: 0, failed: 0 };
  let accepted = 0;
  for (let index = 0; index < paths.length; index += 32) {
    const results = await Promise.all(paths.slice(index, index + 32).map(requestHydration));
    accepted += results.filter(Boolean).length;
  }
  return { available: true, requested: paths.length, accepted, failed: paths.length - accepted };
}

export async function readSourceFiles(paths: string[], options: SourceReaderOptions = {}): Promise<{ files: Map<string, Buffer>; receipt: SourceReadReceipt }> {
  const maxWaves = positiveInteger(options.maxWaves ?? 24, "maxWaves");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
  const concurrency = positiveInteger(options.concurrency ?? 16, "concurrency");
  const batchDelayMs = options.batchDelayMs ?? 5_000;
  if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) throw new Error("batchDelayMs must be non-negative");
  const read = options.read ?? ((path: string, signal: AbortSignal) => readFile(path, { signal }));
  const hydrate = options.hydrate ?? hydrateOnMac;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const files = new Map<string, Buffer>();
  const waves: SourceReadWaveReceipt[] = [];
  const terminalFailures: FailedRead[] = [];
  let pending = [...paths];
  let latestRetryable: FailedRead[] = [];
  let hydration: HydrationReceipt = { available: false, requested: 0, accepted: 0, failed: 0 };

  for (let wave = 1; wave <= maxWaves && pending.length > 0; wave += 1) {
    if (wave > 1 && batchDelayMs > 0) await sleep(batchDelayMs);
    const started = Date.now();
    const failures: FailedRead[] = [];
    for (let index = 0; index < pending.length; index += concurrency) {
      const chunk = pending.slice(index, index + concurrency);
      const results = await Promise.all(chunk.map(async (path): Promise<ReadResult> => {
        try {
          return { path, bytes: await read(path, AbortSignal.timeout(timeoutMs)) };
        } catch (error) {
          return { path, failure: { path, errorClass: errorClass(error), retryable: isRetryableReadError(error) } satisfies FailedRead };
        }
      }));
      for (const result of results) {
        if (result.bytes !== undefined) files.set(result.path, result.bytes);
        else failures.push(result.failure);
      }
    }
    const retryableFailures = failures.filter((failure) => failure.retryable);
    const newTerminalFailures = failures.filter((failure) => !failure.retryable);
    terminalFailures.push(...newTerminalFailures);
    latestRetryable = retryableFailures;
    waves.push({
      wave,
      attempted: pending.length,
      succeeded: pending.length - failures.length,
      retryable: retryableFailures.length,
      terminal: newTerminalFailures.length,
      errorClasses: countClasses(failures),
      durationMs: Date.now() - started
    });
    pending = retryableFailures.map((failure) => failure.path);
    if ((wave === 1 || wave % 6 === 0) && pending.length > 0) {
      const result = await hydrate(pending);
      hydration = {
        available: hydration.available || (result.available ?? true),
        requested: hydration.requested + result.requested,
        accepted: hydration.accepted + result.accepted,
        failed: hydration.failed + result.failed
      };
    }
  }

  const finalFailures = [...terminalFailures, ...latestRetryable];
  const receipt: SourceReadReceipt = {
    discovered: paths.length,
    readable: files.size,
    failed: finalFailures.length,
    hydration,
    waves,
    finalErrorClasses: countClasses(finalFailures)
  };
  if (finalFailures.length > 0) throw new SourceReadError(receipt);
  return { files, receipt };
}