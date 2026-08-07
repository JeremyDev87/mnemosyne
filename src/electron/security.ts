import type { WebPreferences } from "electron";

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false
  };
}

export function isTrustedIpcSender(actualWebContentsId: number, expectedWebContentsId: number): boolean {
  return Number.isSafeInteger(actualWebContentsId) && actualWebContentsId === expectedWebContentsId;
}

export function isAllowedNavigation(actualUrl: string, rendererEntryUrl: string): boolean {
  try {
    return new URL(actualUrl).href === new URL(rendererEntryUrl).href;
  } catch {
    return false;
  }
}
