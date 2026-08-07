import type { IpcMain } from "electron";
import { IPC_CHANNELS, documentRequestSchema, searchRequestSchema } from "./contracts";
import { isTrustedIpcSender } from "./security";
import type { DobbyWikiAdapter } from "../wiki/dobby-adapter";

export function registerIpcHandlers(ipcMain: IpcMain, trustedWebContentsId: number, adapter: DobbyWikiAdapter): () => void {
  const trusted = (actualId: number): void => {
    if (!isTrustedIpcSender(actualId, trustedWebContentsId)) throw new Error("Request rejected");
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch {
      throw new Error("Request rejected");
    }
  };

  ipcMain.handle(IPC_CHANNELS.health, (event) => safe(async () => {
    trusted(event.sender.id);
    return adapter.health();
  }));
  ipcMain.handle(IPC_CHANNELS.search, (event, input: unknown) => safe(async () => {
    trusted(event.sender.id);
    return adapter.search(searchRequestSchema.parse(input));
  }));
  ipcMain.handle(IPC_CHANNELS.getDocument, (event, input: unknown) => safe(async () => {
    trusted(event.sender.id);
    return adapter.getDocument(documentRequestSchema.parse(input));
  }));
  ipcMain.handle(IPC_CHANNELS.personalOps, (event) => safe(async () => {
    trusted(event.sender.id);
    return adapter.personalOps();
  }));

  return () => {
    Object.values(IPC_CHANNELS).forEach((channel) => ipcMain.removeHandler(channel));
  };
}
