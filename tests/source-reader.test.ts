import { describe, expect, it, vi } from "vitest";
import { SourceReadError, readSourceFiles } from "../src/wiki/source-reader";

function retryableReadError(): NodeJS.ErrnoException {
  const error = new Error("Unknown system error -11") as NodeJS.ErrnoException;
  error.errno = -11;
  error.code = "Unknown system error -11";
  return error;
}

describe("cloud-backed source reader", () => {
  it("hydrates retryable files once and retries them in batch waves", async () => {
    const attempts = new Map<string, number>();
    const hydrate = vi.fn(async (paths: string[]) => ({ requested: paths.length, accepted: paths.length, failed: 0 }));
    const sleep = vi.fn(async () => undefined);

    const result = await readSourceFiles(["ready.md", "dataless.md"], {
      read: async (path) => {
        const attempt = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, attempt);
        if (path === "dataless.md" && attempt === 1) throw retryableReadError();
        return Buffer.from(path);
      },
      hydrate,
      sleep,
      batchDelayMs: 25,
      maxWaves: 3
    });

    expect(hydrate).toHaveBeenCalledWith(["dataless.md"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.files.get("ready.md")?.toString()).toBe("ready.md");
    expect(result.files.get("dataless.md")?.toString()).toBe("dataless.md");
    expect(result.receipt.waves.map(({ attempted, succeeded, retryable }) => ({ attempted, succeeded, retryable }))).toEqual([
      { attempted: 2, succeeded: 1, retryable: 1 },
      { attempted: 1, succeeded: 1, retryable: 0 }
    ]);
  });

  it("fails closed with aggregate evidence and never prints private paths", async () => {
    const privatePath = "/private/wiki/secret-title.md";
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";

    await expect(readSourceFiles([privatePath], {
      read: async () => { throw error; },
      hydrate: async () => ({ requested: 0, accepted: 0, failed: 0 }),
      sleep: async () => undefined,
      maxWaves: 2
    })).rejects.toSatisfy((caught: unknown) => {
      expect(caught).toBeInstanceOf(SourceReadError);
      expect((caught as Error).message).not.toContain(privatePath);
      expect((caught as SourceReadError).receipt.failed).toBe(1);
      expect((caught as SourceReadError).receipt.finalErrorClasses).toEqual({ EACCES: 1 });
      return true;
    });
  });

  it("treats a timed-out read as retryable without per-file sleeps", async () => {
    const sleep = vi.fn(async () => undefined);
    const read = (_path: string, signal: AbortSignal) => new Promise<Buffer>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    await expect(readSourceFiles(["a.md", "b.md"], {
      read,
      hydrate: async (paths) => ({ requested: paths.length, accepted: 0, failed: paths.length }),
      sleep,
      timeoutMs: 5,
      batchDelayMs: 1,
      maxWaves: 2
    })).rejects.toBeInstanceOf(SourceReadError);

    expect(sleep).toHaveBeenCalledTimes(1);
  });
});