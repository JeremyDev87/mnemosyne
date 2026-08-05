import { describe, expect, it, vi } from "vitest";
import { SourceReadError, readSourceFiles } from "../src/wiki/source-reader";

function retryableReadError(): NodeJS.ErrnoException {
  const error = new Error("Unknown system error -11") as NodeJS.ErrnoException;
  error.errno = -11;
  error.code = "Unknown system error -11";
  return error;
}

describe("bounded source reader", () => {
  it("hydrates retryable files once and retries them in batch waves", async () => {
    const attempts = new Map<string, number>();
    const delivered = new Map<string, string>();
    const hydrate = vi.fn(async (paths: string[]) => ({ requested: paths.length, accepted: paths.length, failed: 0 }));
    const sleep = vi.fn(async () => undefined);

    const result = await readSourceFiles(["ready.md", "dataless.md"], {
      read: async (path) => {
        const attempt = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, attempt);
        if (path === "dataless.md" && attempt === 1) throw retryableReadError();
        return Buffer.from(path);
      },
      onRead: async (path, bytes) => { delivered.set(path, bytes.toString()); },
      hydrate,
      sleep,
      batchDelayMs: 25,
      maxWaves: 3
    });

    expect(hydrate).toHaveBeenCalledWith(["dataless.md"]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual(new Map([["ready.md", "ready.md"], ["dataless.md", "dataless.md"]]));
    expect(result.receipt.waves.map(({ attempted, succeeded, retryable }) => ({ attempted, succeeded, retryable }))).toEqual([
      { attempted: 2, succeeded: 1, retryable: 1 },
      { attempted: 1, succeeded: 1, retryable: 0 }
    ]);
  });

  it("enforces a hard deadline even when the reader ignores AbortSignal", async () => {
    const started = performance.now();
    await expect(readSourceFiles(["stuck.md"], {
      read: async () => new Promise<Buffer>(() => undefined),
      onRead: async () => undefined,
      hydrate: async (paths) => ({ requested: paths.length, accepted: 0, failed: paths.length }),
      timeoutMs: 5,
      maxWaves: 1
    })).rejects.toSatisfy((caught: unknown) => {
      expect(caught).toBeInstanceOf(SourceReadError);
      expect((caught as SourceReadError).receipt.finalErrorClasses).toEqual({ ETIMEDOUT: 1 });
      return true;
    });
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("bounds retained bytes to one concurrency chunk", async () => {
    let delivered = 0;
    const result = await readSourceFiles(Array.from({ length: 20 }, (_, index) => `${index}.md`), {
      read: async () => Buffer.alloc(4),
      onRead: async () => { delivered += 1; },
      concurrency: 2
    });

    expect(delivered).toBe(20);
    expect(result).not.toHaveProperty("files");
    expect(result.receipt.peakBufferedBytes).toBeLessThanOrEqual(8);
  });

  it("rejects a file above the configured per-file memory bound", async () => {
    await expect(readSourceFiles(["large.md"], {
      read: async () => Buffer.alloc(5),
      onRead: async () => undefined,
      maxFileBytes: 4,
      maxWaves: 1
    })).rejects.toSatisfy((caught: unknown) => {
      expect(caught).toBeInstanceOf(SourceReadError);
      expect((caught as SourceReadError).receipt.finalErrorClasses).toEqual({ EFBIG: 1 });
      return true;
    });
  });

  it("fails closed with aggregate evidence and never prints private paths", async () => {
    const privatePath = "/private/wiki/secret-title.md";
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";

    await expect(readSourceFiles([privatePath], {
      read: async () => { throw error; },
      onRead: async () => undefined,
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
});
