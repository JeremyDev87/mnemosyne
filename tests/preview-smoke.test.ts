import { describe, expect, it } from "vitest";
import { runPreviewSmoke } from "../scripts/verify-preview-smoke";

const CANARY = "PRIVATE_CANARY_QUERY";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";

function response(status: number, body: unknown = {}): Response {
  return Response.json(body, { status });
}

describe("preview smoke evidence", () => {
  it("proves deny, synthetic POST search, read-only PUT, and deployment identity without leaking inputs", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let mutationCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      if (calls.length === 1) return response(403);
      if (calls.length === 2) return response(200, { results: [{ path: "private/path.md", excerpt: "PRIVATE_CONTENT" }] });
      if (calls.length === 3) return response(403);
      mutationCount += 1;
      return response(500);
    };

    const receipt = await runPreviewSmoke({
      baseUrl: "https://mnemosyne.example.com",
      deploymentId: DEPLOYMENT_ID,
      canaryQuery: CANARY,
      accessHeaders: { "CF-Access-Client-Id": "PRIVATE_ID", "CF-Access-Client-Secret": "PRIVATE_SECRET" }
    }, fetcher);

    expect(receipt).toMatchObject({ state: "passed", passed: true, deploymentId: DEPLOYMENT_ID });
    expect(receipt.checks).toEqual({ unauthorizedDenied: true, syntheticSearchPassed: true, writesDenied: true, deploymentRecorded: true });
    expect(receipt.observations).toEqual({ unauthorizedStatus: 403, searchStatus: 200, searchResultCount: 1, writeStatus: 403 });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe("https://mnemosyne.example.com/api/wiki/search");
    expect(calls[1]!.url).not.toContain(CANARY);
    expect(mutationCount).toBe(0);
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [CANARY, "private/path.md", "PRIVATE_CONTENT", "PRIVATE_ID", "PRIVATE_SECRET"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails closed when any smoke observation is unsafe or the deployment id is invalid", async () => {
    let call = 0;
    const fetcher: typeof fetch = async () => {
      call += 1;
      if (call === 1) return response(404);
      if (call === 2) return response(200, { results: [] });
      return response(200);
    };

    const receipt = await runPreviewSmoke({
      baseUrl: "https://mnemosyne.example.com",
      deploymentId: "PRIVATE_INVALID_DEPLOYMENT_VALUE",
      canaryQuery: CANARY,
      accessHeaders: {}
    }, fetcher);

    expect(receipt).toMatchObject({ state: "failed", passed: false, deploymentId: null });
    expect(receipt.checks).toEqual({ unauthorizedDenied: false, syntheticSearchPassed: false, writesDenied: false, deploymentRecorded: false });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_INVALID_DEPLOYMENT_VALUE");
  });
});
