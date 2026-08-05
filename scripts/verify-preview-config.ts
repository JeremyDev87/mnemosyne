import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PLACEHOLDER_D1_ID = "00000000-0000-0000-0000-000000000000";

interface PreviewChecks {
  workersDevDisabled: boolean;
  previewUrlsDisabled: boolean;
  accessRequired: boolean;
  aiDisabled: boolean;
  aiBindingAbsent: boolean;
  shadowPrefix: boolean;
  writesDisabled: boolean;
  d1Configured: boolean;
  customDomainConfigured: boolean;
}

export interface PreviewConfigReceipt {
  version: 1;
  state: "unsafe" | "provider-pending" | "ready";
  passed: boolean;
  privacyReady: boolean;
  providerReady: boolean;
  checks: PreviewChecks;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : [];
}

export function verifyPreviewConfig(input: unknown): PreviewConfigReceipt {
  const config = record(input);
  const vars = record(config.vars);
  const d1Configured = records(config.d1_databases).some((database) =>
    database.binding === "WIKI_INDEX" &&
    typeof database.database_id === "string" &&
    database.database_id.length > 0 &&
    database.database_id !== PLACEHOLDER_D1_ID
  );
  const customDomainConfigured = records(config.routes).some((route) =>
    route.custom_domain === true && typeof route.pattern === "string" && route.pattern.length > 0
  );
  const checks: PreviewChecks = {
    workersDevDisabled: config.workers_dev === false,
    previewUrlsDisabled: config.preview_urls === false,
    accessRequired: vars.AUTH_MODE === "access",
    aiDisabled: vars.AI_ENABLED === "false",
    aiBindingAbsent: !("ai" in config),
    shadowPrefix: vars.R2_PREFIX === "shadow",
    writesDisabled: vars.WRITE_ENABLED === "false",
    d1Configured,
    customDomainConfigured
  };
  const privacyReady = checks.workersDevDisabled && checks.previewUrlsDisabled && checks.accessRequired &&
    checks.aiDisabled && checks.aiBindingAbsent && checks.shadowPrefix && checks.writesDisabled;
  const providerReady = checks.d1Configured && checks.customDomainConfigured;
  return {
    version: 1,
    state: !privacyReady ? "unsafe" : providerReady ? "ready" : "provider-pending",
    passed: privacyReady,
    privacyReady,
    providerReady,
    checks
  };
}

async function main(): Promise<void> {
  const configFlag = process.argv.indexOf("--config");
  const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : undefined;
  if (!configPath) {
    process.stdout.write(`${JSON.stringify({ version: 1, state: "invalid-arguments", passed: false })}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    const receipt = verifyPreviewConfig(config);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.passed && (!process.argv.includes("--require-provider") || receipt.providerReady) ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ version: 1, state: "invalid-config", passed: false })}\n`);
    process.exitCode = 2;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
