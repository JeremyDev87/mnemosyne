import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../src/electron/ipc-handlers";
import { IPC_CHANNELS } from "../src/electron/contracts";
import type { DobbyWikiAdapter } from "../src/wiki/dobby-adapter";

type Handler = (event: { sender: { id: number } }, input?: unknown) => Promise<unknown>;

function createIpcMain() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`);
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    })
  } as unknown as IpcMain;
  return { ipcMain, handlers };
}

function sender(id: number) {
  return { sender: { id } };
}

function adapterFixture() {
  return {
    health: vi.fn(async () => ({ status: "ok" })),
    search: vi.fn(async (request: unknown) => ({ request })),
    getDocument: vi.fn(async (request: unknown) => ({ request })),
    personalOps: vi.fn(async () => ({ status: "ok" }))
  } as unknown as DobbyWikiAdapter & {
    health: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    getDocument: ReturnType<typeof vi.fn>;
    personalOps: ReturnType<typeof vi.fn>;
  };
}

describe("Electron IPC capability handlers", () => {
  it("registers each capability once and rejects every wrong sender without invoking the adapter", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const adapter = adapterFixture();
    registerIpcHandlers(ipcMain, 42, adapter);

    expect([...handlers.keys()]).toEqual([
      IPC_CHANNELS.health,
      IPC_CHANNELS.search,
      IPC_CHANNELS.getDocument,
      IPC_CHANNELS.personalOps
    ]);
    expect(ipcMain.handle).toHaveBeenCalledTimes(4);

    const requests: Array<[string, unknown?]> = [
      [IPC_CHANNELS.health],
      [IPC_CHANNELS.search, { query: "일정", limit: 5 }],
      [IPC_CHANNELS.getDocument, { documentId: "a".repeat(64) }],
      [IPC_CHANNELS.personalOps]
    ];
    for (const [channel, input] of requests) {
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(handler!(sender(7), input)).rejects.toThrow("Request rejected");
    }

    expect(adapter.health).not.toHaveBeenCalled();
    expect(adapter.search).not.toHaveBeenCalled();
    expect(adapter.getDocument).not.toHaveBeenCalled();
    expect(adapter.personalOps).not.toHaveBeenCalled();
  });

  it("rejects malformed or extra-field inputs before calling the adapter", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const adapter = adapterFixture();
    registerIpcHandlers(ipcMain, 42, adapter);

    await expect(handlers.get(IPC_CHANNELS.search)!(sender(42), { query: "", limit: 5 }))
      .rejects.toThrow("Request rejected");
    await expect(handlers.get(IPC_CHANNELS.search)!(sender(42), { query: "일정", extra: "nope" }))
      .rejects.toThrow("Request rejected");
    await expect(handlers.get(IPC_CHANNELS.search)!(sender(42), { query: "일정", limit: 21 }))
      .rejects.toThrow("Request rejected");
    await expect(handlers.get(IPC_CHANNELS.getDocument)!(sender(42), { documentId: "../private.md" }))
      .rejects.toThrow("Request rejected");
    await expect(handlers.get(IPC_CHANNELS.getDocument)!(sender(42), { documentId: "a".repeat(64), extra: true }))
      .rejects.toThrow("Request rejected");

    expect(adapter.search).not.toHaveBeenCalled();
    expect(adapter.getDocument).not.toHaveBeenCalled();
  });

  it("normalizes valid requests, preserves results, and redacts adapter failures", async () => {
    const { ipcMain, handlers } = createIpcMain();
    const adapter = adapterFixture();
    adapter.search.mockResolvedValueOnce({ hits: [], snapshotState: "fresh" });
    registerIpcHandlers(ipcMain, 42, adapter);

    await expect(handlers.get(IPC_CHANNELS.health)!(sender(42))).resolves.toEqual({ status: "ok" });
    await expect(handlers.get(IPC_CHANNELS.search)!(sender(42), { query: " 일정 ", limit: 5 }))
      .resolves.toEqual({ hits: [], snapshotState: "fresh" });
    await expect(handlers.get(IPC_CHANNELS.getDocument)!(sender(42), { documentId: "b".repeat(64) }))
      .resolves.toEqual({ request: { documentId: "b".repeat(64) } });
    await expect(handlers.get(IPC_CHANNELS.personalOps)!(sender(42))).resolves.toEqual({ status: "ok" });

    expect(adapter.search).toHaveBeenCalledWith({ query: "일정", limit: 5 });

    adapter.search.mockRejectedValueOnce(new Error("private /usr/local/bin/dobby-wiki command=secret"));
    const failure = handlers.get(IPC_CHANNELS.search)!(sender(42), { query: "일정" });
    await expect(failure).rejects.toThrow("Request rejected");
    await expect(failure).rejects.not.toThrow(/private|dobby-wiki|secret/);
  });

  it("removes all handlers on dispose and permits exactly one clean re-registration", () => {
    const { ipcMain, handlers } = createIpcMain();
    const adapter = adapterFixture();
    const dispose = registerIpcHandlers(ipcMain, 42, adapter);

    dispose();
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4);
    expect(handlers.size).toBe(0);

    registerIpcHandlers(ipcMain, 42, adapter);
    expect(ipcMain.handle).toHaveBeenCalledTimes(8);
    expect(handlers.size).toBe(4);
  });
});
