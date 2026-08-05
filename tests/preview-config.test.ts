import { describe, expect, it } from "vitest";
import { verifyPreviewConfig } from "../scripts/verify-preview-config";

function safeConfig(): Record<string, unknown> {
  return {
    workers_dev: false,
    preview_urls: false,
    vars: {
      AUTH_MODE: "access",
      AI_ENABLED: "false",
      R2_PREFIX: "shadow",
      WRITE_ENABLED: "false"
    },
    r2_buckets: [{ binding: "WIKI", bucket_name: "mnemosyne-wiki" }],
    d1_databases: [{ binding: "WIKI_INDEX", database_name: "mnemosyne-index", database_id: "11111111-1111-4111-8111-111111111111" }],
    routes: [{ pattern: "mnemosyne.example.com", custom_domain: true }]
  };
}

describe("preview config verifier", () => {
  it("passes a privacy-safe and provider-ready config", () => {
    const receipt = verifyPreviewConfig(safeConfig());

    expect(receipt).toEqual({
      version: 1,
      state: "ready",
      passed: true,
      privacyReady: true,
      providerReady: true,
      checks: {
        workersDevDisabled: true,
        previewUrlsDisabled: true,
        accessRequired: true,
        aiDisabled: true,
        aiBindingAbsent: true,
        shadowPrefix: true,
        writesDisabled: true,
        d1Configured: true,
        customDomainConfigured: true
      }
    });
  });

  it("distinguishes a privacy-safe pre-provision config from deploy readiness", () => {
    const config = safeConfig();
    config.d1_databases = [{ binding: "WIKI_INDEX", database_name: "mnemosyne-index", database_id: "00000000-0000-0000-0000-000000000000" }];
    delete config.routes;

    const receipt = verifyPreviewConfig(config);

    expect(receipt).toMatchObject({ state: "provider-pending", passed: true, privacyReady: true, providerReady: false });
    expect(receipt.checks).toMatchObject({ d1Configured: false, customDomainConfigured: false });
  });

  it("fails closed on every privacy gate drift without returning config values", () => {
    const config = safeConfig();
    config.workers_dev = true;
    config.preview_urls = true;
    config.ai = { binding: "PRIVATE_BINDING_NAME" };
    config.vars = {
      AUTH_MODE: "test",
      AI_ENABLED: "true",
      R2_PREFIX: "canonical/private",
      WRITE_ENABLED: "true",
      ALLOWED_EMAILS: "private@example.com"
    };

    const receipt = verifyPreviewConfig(config);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({ state: "unsafe", passed: false, privacyReady: false });
    expect(serialized).not.toContain("PRIVATE_BINDING_NAME");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("canonical/private");
  });
});
