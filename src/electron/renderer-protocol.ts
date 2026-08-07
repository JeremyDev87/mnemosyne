import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export const rendererEntryUrl = "mnemosyne://renderer/main_window/index.html";
const rendererProtocol = "mnemosyne:";
const rendererHost = "renderer";
const allowedAssets = new Set(["main_window/index.html", "main_window/index.js", "main_window/index.js.LICENSE.txt"]);

export function rendererAssetPath(appPath: string, requestUrl: string): string | undefined {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== rendererProtocol || url.hostname !== rendererHost || url.search || url.hash) return undefined;
    const root = resolve(appPath, ".webpack", "renderer");
    const candidate = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const asset = relative(root, candidate).replaceAll("\\", "/");
    if (asset.startsWith("../") || asset === ".." || !allowedAssets.has(asset)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

export async function serveRendererAsset(appPath: string, requestUrl: string): Promise<Response> {
  const assetPath = rendererAssetPath(appPath, requestUrl);
  if (!assetPath) return new Response("Not found", { status: 404 });
  try {
    const type = assetPath.endsWith(".html") ? "text/html; charset=utf-8" : "application/javascript; charset=utf-8";
    return new Response(await readFile(assetPath), { headers: { "content-type": type } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
