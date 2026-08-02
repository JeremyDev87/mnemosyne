import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;

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
  peakBufferedBytes: number;
  hydration: HydrationReceipt;
  waves: SourceReadWaveReceipt[];
  finalErrorClasses: Record<string, number>;
}

export interface SourceReaderOptions {
  read?: (path: string, signal: AbortSignal) => Promise<Buffer>;
  onRead?: (path: string, bytes: Buffer) => Promise<void> | void;
  hydrate?: (paths: string[]) => Promise<Omit<HydrationReceipt, "available"> & { available?: boolean }>;
  sleep?: (milliseconds: number) => Promise<void>;
  root?: string;
  maxWaves?: number;
  timeoutMs?: number;
  batchDelayMs?: number;
  concurrency?: number;
  maxFileBytes?: number;
}

export class SourceReadError extends Error {
  constructor(public readonly receipt: SourceReadReceipt) {
    super(`Source scan failed closed: ${receipt.failed} unreadable file(s); errors=${JSON.stringify(receipt.finalErrorClasses)}`);
    this.name = "SourceReadError";
  }
}

interface FailedRead { path: string; errorClass: string; retryable: boolean }
type ReadResult = { path: string; bytes: Buffer; failure?: never } | { path: string; bytes?: never; failure: FailedRead };

const RETRYABLE_CODES = new Set(["EAGAIN", "EDEADLK", "EBUSY", "ENOENT", "ABORT_ERR", "AbortError", "TimeoutError", "ETIMEDOUT"]);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
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

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function createRootBoundReader(root: string, maxFileBytes: number): (path: string, signal: AbortSignal) => Promise<Buffer> {
  const resolvedRoot = resolve(root);
  const canonicalRoot = realpath(resolvedRoot);
  return async (path, signal) => {
    const expectedRoot = await canonicalRoot;
    const absolute = resolve(path);
    if (!isWithinRoot(resolvedRoot, absolute)) throw codedError("EBOUNDARY", "Source path escapes configured root");

    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (errorClass(error) === "ELOOP") throw codedError("ESYMLINK", "Source path resolves through a symbolic link");
      throw error;
    }

    try {
      const [canonicalPath, handleInfo] = await Promise.all([realpath(absolute), handle.stat()]);
      if (!isWithinRoot(expectedRoot, canonicalPath)) throw codedError("EBOUNDARY", "Source path leaves the canonical source boundary");
      const pathInfo = await stat(canonicalPath);
      if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) throw codedError("EBOUNDARY", "Source path changed during descriptor binding");
      if (!handleInfo.isFile()) throw codedError("EINVAL", "Source path is not a regular file");
      if (handleInfo.size > maxFileBytes) throw codedError("EFBIG", "Source file exceeds the per-file memory limit");
      return await readFile(handle, { signal });
    } finally {
      await handle.close();
    }
  };
}

function readWithHardDeadline(
  path: string,
  read: (path: string, signal: AbortSignal) => Promise<Buffer>,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController();
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => rejectPromise(codedError("ETIMEDOUT", "Source read hard deadline exceeded")));
    }, timeoutMs);
    Promise.resolve()
      .then(() => read(path, controller.signal))
      .then(
        (bytes) => finish(() => resolvePromise(bytes)),
        (error: unknown) => finish(() => rejectPromise(error))
      );
  });
}

function requestHydration(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("/usr/bin/brctl", ["download", path], { stdio: "ignore" });
    let settled = false;
    const finish = (accepted: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(accepted);
    };
    const timer = setTimeout(() => { child.kill(); finish(false); }, 10_000);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
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

export async function readSourceFiles(paths: string[], options: SourceReaderOptions = {}): Promise<{ receipt: SourceReadReceipt }> {
  const maxWaves = positiveInteger(options.maxWaves ?? 24, "maxWaves");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 15_000, "timeoutMs");
  const concurrency = positiveInteger(options.concurrency ?? 8, "concurrency");
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? MAX_SOURCE_FILE_BYTES, "maxFileBytes");
  const batchDelayMs = options.batchDelayMs ?? 5_000;
  if (!Number.isFinite(batchDelayMs) || batchDelayMs < 0) throw new Error("batchDelayMs must be non-negative");
  if (!options.onRead) throw new Error("onRead is required so successful bytes can be released after each bounded chunk");
  if (!options.read && !options.root) throw new Error("root is required for the default no-follow source reader");
  const read = options.read ?? createRootBoundReader(options.root as string, maxFileBytes);
  const onRead = options.onRead;
  const hydrate = options.hydrate ?? hydrateOnMac;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const waves: SourceReadWaveReceipt[] = [];
  const terminalFailures: FailedRead[] = [];
  let pending = [...paths];
  let latestRetryable: FailedRead[] = [];
  let readable = 0;
  let peakBufferedBytes = 0;
  let hydration: HydrationReceipt = { available: false, requested: 0, accepted: 0, failed: 0 };

  for (let wave = 1; wave <= maxWaves && pending.length > 0; wave += 1) {
    if (wave > 1 && batchDelayMs > 0) await sleep(batchDelayMs);
    const started = Date.now();
    const failures: FailedRead[] = [];
    for (let index = 0; index < pending.length; index += concurrency) {
      const chunk = pending.slice(index, index + concurrency);
      const results = await Promise.all(chunk.map(async (path): Promise<ReadResult> => {
        try {
          const bytes = await readWithHardDeadline(path, read, timeoutMs);
          if (bytes.byteLength > maxFileBytes) throw codedError("EFBIG", "Source file exceeds the per-file memory limit");
          return { path, bytes };
        } catch (error) {
          return { path, failure: { path, errorClass: errorClass(error), retryable: isRetryableReadError(error) } satisfies FailedRead };
        }
      }));
      const bufferedBytes = results.reduce((sum, result) => sum + (result.bytes?.byteLength ?? 0), 0);
      peakBufferedBytes = Math.max(peakBufferedBytes, bufferedBytes);
      for (const result of results) {
        if (result.bytes !== undefined) {
          await onRead(result.path, result.bytes);
          readable += 1;
        } else {
          failures.push(result.failure);
        }
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
    readable,
    failed: finalFailures.length,
    peakBufferedBytes,
    hydration,
    waves,
    finalErrorClasses: countClasses(finalFailures)
  };
  if (finalFailures.length > 0) throw new SourceReadError(receipt);
  return { receipt };
}
