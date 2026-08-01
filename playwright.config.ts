import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://127.0.0.1:8787", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: "npm run seed:local && npm run dev",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
