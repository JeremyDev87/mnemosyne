import { app, BrowserWindow, ipcMain, Menu, protocol, session } from "electron";
import { join, resolve } from "node:path";
import { registerIpcHandlers } from "./ipc-handlers";
import { isAllowedNavigation, secureWebPreferences } from "./security";
import { DobbyWikiAdapter } from "../wiki/dobby-adapter";
import type { SnapshotTrustAnchor } from "../wiki/snapshot-attestation";
import { loadProvisionedTrustAnchor } from "../trust/trust-anchor";
import { parseOwnerActivationOperation, runOwnerActivationOperation } from "../trust/owner-activation";
import { admitBundledDobbyCommand } from "../wiki/dobby-command";
import { rendererEntryUrl, serveRendererAsset } from "./renderer-protocol";

declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const __MNEMOSYNE_E2E_BUILD__: boolean;

protocol.registerSchemesAsPrivileged([{
  scheme: "mnemosyne",
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}]);

let mainWindow: BrowserWindow | null = null;
let disposeIpc: (() => void) | undefined;
let windowCreation: Promise<BrowserWindow> | undefined;

function wikiStateRoot(): string {
  if (__MNEMOSYNE_E2E_BUILD__) {
    const fixtureRoot = process.env.MNEMOSYNE_E2E_STATE_ROOT;
    if (!fixtureRoot) throw new Error("E2E snapshot fixture root is required");
    return resolve(fixtureRoot);
  }
  return join(app.getPath("home"), "Library", "Application Support", "Mnemosyne", "fixed-projection");
}

async function wikiTrustAnchor(): Promise<SnapshotTrustAnchor | undefined> {
  if (!__MNEMOSYNE_E2E_BUILD__) {
    return loadProvisionedTrustAnchor(join(process.resourcesPath, "mnemosyne-trust-helper"));
  }
  const keyId = process.env.MNEMOSYNE_E2E_TRUST_KEY_ID;
  const publicKeyPem = process.env.MNEMOSYNE_E2E_TRUST_PUBLIC_KEY;
  const sequenceText = process.env.MNEMOSYNE_E2E_TRUST_ACCEPTED_SEQUENCE;
  const acceptedAttestationId = process.env.MNEMOSYNE_E2E_TRUST_ACCEPTED_ATTESTATION_ID;
  const acceptedSequence = Number(sequenceText);
  if (!keyId || !publicKeyPem || !sequenceText || !acceptedAttestationId || !Number.isSafeInteger(acceptedSequence) || acceptedSequence < 0) {
    throw new Error("E2E snapshot trust anchor is required");
  }
  return { keyId, publicKeyPem, acceptedSequence, acceptedAttestationId };
}

function wikiCommandAdmission(): (() => Promise<string>) | undefined {
  if (!__MNEMOSYNE_E2E_BUILD__) {
    return async () => {
      const admission = await admitBundledDobbyCommand({
        resourcesPath: process.resourcesPath,
        runtimeRoot: "/Library/Application Support/Mnemosyne/dobby-runtime",
        appExecutable: process.execPath
      });
      return admission.command;
    };
  }
  return undefined;
}

function wikiCommand(): string | undefined {
  const command = process.env.MNEMOSYNE_E2E_DOBBY_COMMAND;
  if (!command) throw new Error("E2E trusted Wiki command is required");
  return resolve(command);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#f5f7f6",
    title: "Mnemosyne",
    webPreferences: secureWebPreferences(MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY)
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, rendererEntryUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  try {
    const adapter = new DobbyWikiAdapter({
      stateRoot: wikiStateRoot(),
      ...(__MNEMOSYNE_E2E_BUILD__ ? {} : { commandStateRoot: join(wikiStateRoot(), "runtime") }),
      trustAnchor: await wikiTrustAnchor(),
      command: __MNEMOSYNE_E2E_BUILD__ ? wikiCommand() : undefined,
      admitCommand: wikiCommandAdmission()
    });
    disposeIpc?.();
    disposeIpc = registerIpcHandlers(ipcMain, window.webContents.id, adapter);
    void window.loadURL(rendererEntryUrl);
    return window;
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
}

function ensureMainWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  if (windowCreation) return windowCreation;
  windowCreation = createMainWindow()
    .then((window) => {
      if (window.isDestroyed()) throw new Error("Main window closed during initialization");
      mainWindow = window;
      return window;
    })
    .finally(() => {
      windowCreation = undefined;
    });
  return windowCreation;
}

app.whenReady().then(async () => {
  const ownerOperation = parseOwnerActivationOperation(process.argv.slice(1));
  if (ownerOperation) {
    try {
      const result = await runOwnerActivationOperation(
        join(process.resourcesPath, "mnemosyne-trust-helper"),
        ownerOperation,
        undefined,
        join(app.getPath("home"), "Library", "Application Support", "Mnemosyne", "fixed-projection")
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      app.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown failure";
      process.stderr.write(`Mnemosyne owner activation failed: ${message}\n`);
      app.exit(1);
    }
    return;
  }
  protocol.handle("mnemosyne", (request) => serveRendererAsset(app.getAppPath(), request.url));
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  void ensureMainWindow().catch(() => {
    if (!__MNEMOSYNE_E2E_BUILD__) console.error("Mnemosyne window initialization failed");
    else app.quit();
  });
  app.on("activate", () => {
    void ensureMainWindow().catch(() => console.error("Mnemosyne window activation failed"));
  });
});

app.on("window-all-closed", () => {
  disposeIpc?.();
  if (process.platform !== "darwin") app.quit();
});
