import { pathToFileURL } from "node:url";

const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_PROBE = {
  path: "domains/personal-ops/inbox.md",
  content: "# Preview write-denial probe\n",
  baseEtag: "preview-smoke-nonexistent-etag"
};

export interface PreviewSmokeOptions {
  baseUrl: string;
  deploymentId: string;
  canaryQuery: string;
  accessHeaders: Record<string, string>;
}

export interface PreviewSmokeReceipt {
  version: 1;
  state: "passed" | "failed";
  passed: boolean;
  deploymentId: string | null;
  checks: {
    unauthorizedDenied: boolean;
    syntheticSearchPassed: boolean;
    writesDenied: boolean;
    deploymentRecorded: boolean;
  };
  observations: {
    unauthorizedStatus: number | null;
    searchStatus: number | null;
    searchResultCount: number | null;
    writeStatus: number | null;
  };
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000)
  };
}

export async function runPreviewSmoke(options: PreviewSmokeOptions, fetcher: typeof fetch = fetch): Promise<PreviewSmokeReceipt> {
  let unauthorizedStatus: number | null = null;
  let searchStatus: number | null = null;
  let searchResultCount: number | null = null;
  let writeStatus: number | null = null;

  try {
    const unauthorized = await fetcher(endpoint(options.baseUrl, "/api/wiki/search"), jsonRequest({ query: options.canaryQuery }));
    unauthorizedStatus = unauthorized.status;

    const search = await fetcher(endpoint(options.baseUrl, "/api/wiki/search"), jsonRequest({ query: options.canaryQuery }, options.accessHeaders));
    searchStatus = search.status;
    const searchPayload = await search.json().catch(() => null) as { results?: unknown } | null;
    searchResultCount = Array.isArray(searchPayload?.results) ? searchPayload.results.length : null;

    const write = await fetcher(endpoint(options.baseUrl, "/api/ops/doc"), {
      ...jsonRequest(WRITE_PROBE, options.accessHeaders),
      method: "PUT"
    });
    writeStatus = write.status;
  } catch {
    // The aggregate receipt below intentionally contains no URL, query, identity, or transport detail.
  }

  const deploymentId = DEPLOYMENT_ID.test(options.deploymentId) ? options.deploymentId : null;
  const checks = {
    unauthorizedDenied: unauthorizedStatus !== null && [301, 302, 303, 307, 308, 401, 403].includes(unauthorizedStatus),
    syntheticSearchPassed: searchStatus === 200 && searchResultCount !== null && searchResultCount > 0,
    writesDenied: writeStatus === 403,
    deploymentRecorded: deploymentId !== null
  };
  const passed = Object.values(checks).every(Boolean);
  return {
    version: 1,
    state: passed ? "passed" : "failed",
    passed,
    deploymentId,
    checks,
    observations: { unauthorizedStatus, searchStatus, searchResultCount, writeStatus }
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env.PREVIEW_BASE_URL;
  const deploymentId = process.env.PREVIEW_DEPLOYMENT_ID;
  const canaryQuery = process.env.PREVIEW_CANARY_QUERY;
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!baseUrl || !deploymentId || !canaryQuery || !clientId || !clientSecret) {
    process.stdout.write(`${JSON.stringify({ version: 1, state: "error", passed: false, errorClass: "smoke-input-incomplete" })}\n`);
    process.exitCode = 2;
    return;
  }
  const receipt = await runPreviewSmoke({
    baseUrl,
    deploymentId,
    canaryQuery,
    accessHeaders: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret }
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.passed ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
