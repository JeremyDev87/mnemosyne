import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  documentRequestSchema,
  documentResultSchema,
  healthResultSchema,
  personalOpsResultSchema,
  searchRequestSchema,
  searchResultSchema,
  type DocumentRequest,
  type MnemosyneApi,
  type SearchRequest
} from "./contracts";

const api: MnemosyneApi = Object.freeze({
  async health() {
    return healthResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.health));
  },
  async search(input: SearchRequest) {
    const request = searchRequestSchema.parse(input);
    return searchResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.search, request));
  },
  async getDocument(input: DocumentRequest) {
    const request = documentRequestSchema.parse(input);
    return documentResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getDocument, request));
  },
  async personalOps() {
    return personalOpsResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.personalOps));
  }
});

contextBridge.exposeInMainWorld("mnemosyne", api);
