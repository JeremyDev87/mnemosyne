import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixedRootFixture,
  fixedRootAttestationId,
  independentCanonicalPayload,
  type FixedRootCandidateRequest,
  type FixedRootFixture
} from "./helpers/fixed-root-attestor-fixture";

const fixtures: FixedRootFixture[] = [];

afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose())));

async function fixture(): Promise<FixedRootFixture> {
  const value = await createFixedRootFixture();
  fixtures.push(value);
  return value;
}

async function moduleUnderTest() {
  return import("../src/wiki/fixed-root-attestor");
}

describe("fixed-root attestor M2 contract", () => {
  it("uses independent canonical bytes and verifies a test-only ephemeral P-256 response", async () => {
    const value = await fixture();
    const module = await moduleUnderTest();
    const attestation = module.verifyFixedRootAttestationResponse(value.response, value.request, value.trust);

    expect(value.canonicalBytes).toEqual(independentCanonicalPayload(attestation.payload));
    expect(attestation.payload.generation).toBe(value.request.generation);
    expect(attestation.payload.sequence).toBe(value.request.sequence);
    expect(fixedRootAttestationId(attestation)).not.toBe(value.trust.acceptedAttestationId);
  });

  it("sends exactly the four production candidate request fields and immediately re-verifies the response", async () => {
    const value = await fixture();
    const module = await moduleUnderTest();
    const seen: unknown[] = [];
    const invoke = async (_path: string, request: FixedRootCandidateRequest): Promise<unknown> => {
      seen.push(request);
      return value.response;
    };

    await expect(module.attestFixedRootCandidate("/trusted/helper", value.request, value.trust, invoke)).resolves.toMatchObject({
      payload: value.response["payload"]
    });
    expect(seen).toEqual([value.request]);
    expect(Object.keys(value.request)).toEqual([
      "operation",
      "generation",
      "sequence",
      "previous_attestation_sha256"
    ]);
  });

  it.each([
    { root: "/caller-controlled", payload: { forged: true } },
    { created_at: "2026-08-11T00:00:00Z" },
    { path: "snapshots/other" },
    { operation: "attest-candidate", generation: "../escape", sequence: 7, previous_attestation_sha256: null, extra: true },
    { generation: "." },
    { generation: ".." },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects caller-controlled or unknown request fields before helper invocation: %j", async (extra) => {
    const value = await fixture();
    const module = await moduleUnderTest();
    const invoke = vi.fn(async (): Promise<unknown> => value.response);
    const request = { ...value.request, ...extra };
    const before = await value.snapshot();

    await expect(module.attestFixedRootCandidate("/trusted/helper", request, value.trust, invoke)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    await expect(value.snapshot()).resolves.toEqual(before);
  });

  it("rejects an unknown response field and request/response binding drift", async () => {
    const value = await fixture();
    const module = await moduleUnderTest();
    expect(() => module.verifyFixedRootAttestationResponse({ ...value.response, root: value.root }, value.request, value.trust)).toThrow();
    expect(() => module.verifyFixedRootAttestationResponse(
      value.response,
      { ...value.request, generation: "other-generation" },
      value.trust
    )).toThrow(/generation/i);
  });

  it("records a real symlink fixture rather than a missing-target substitute", async () => {
    const value = await fixture();
    await value.symlinkToOutside("manifest.json");
    const snapshot = await value.snapshot();
    expect(snapshot["manifest.json"]).toMatch(/^symlink:/u);
  });
});
