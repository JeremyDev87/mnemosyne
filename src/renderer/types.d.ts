import type { MnemosyneApi } from "../electron/contracts";

declare global {
  interface Window {
    mnemosyne: MnemosyneApi;
  }
}

export {};
