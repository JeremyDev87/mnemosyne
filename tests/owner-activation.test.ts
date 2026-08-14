import { describe, expect, it, vi } from "vitest";
import { parseOwnerActivationOperation, runOwnerActivationOperation } from "../src/trust/owner-activation";
import { TrustedHelperRejectedError } from "../src/trust/trusted-helper";

const keyId = "a".repeat(64);

describe("packaged owner activation surface", () => {
  it("accepts one exact typed operation and rejects generic or duplicate commands", () => {
    expect(parseOwnerActivationOperation(["app"])).toBeUndefined();
    expect(parseOwnerActivationOperation(["app", "--mnemosyne-owner-operation=key-info"])).toEqual({ operation: "key-info" });
    expect(parseOwnerActivationOperation(["--mnemosyne-owner-operation=activate", "--mnemosyne-generation=gen-0", "--mnemosyne-expected-generation=none"]))
      .toEqual({ operation: "activate", generation: "gen-0", expectedGeneration: null });
    expect(() => parseOwnerActivationOperation(["--mnemosyne-owner-operation=activate", "--mnemosyne-generation=../escape", "--mnemosyne-expected-generation=none"])).toThrow(/invalid/i);
    expect(() => parseOwnerActivationOperation(["--mnemosyne-owner-operation=trust-cas"])).toThrow(/unsupported/i);
    expect(() => parseOwnerActivationOperation(["--mnemosyne-owner-operation=enroll", "--mnemosyne-owner-operation=enroll"])).toThrow(/exactly one/i);
  });

  it("reads an existing identity without enrollment", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "ok", key_id: keyId });
    await expect(runOwnerActivationOperation("/app/helper", { operation: "enroll" }, invoke)).resolves.toMatchObject({ disposition: "already-enrolled", key_id: keyId });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("/app/helper", { operation: "key-info" });
  });

  it("enrolls only after an exact missing-key result and requires matching readback", async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(new TrustedHelperRejectedError("not-enrolled"))
      .mockResolvedValueOnce({ status: "ok", key_id: keyId })
      .mockResolvedValueOnce({ status: "ok", key_id: keyId });
    await expect(runOwnerActivationOperation("/app/helper", { operation: "enroll" }, invoke)).resolves.toMatchObject({ disposition: "enrolled", key_id: keyId });
    expect(invoke.mock.calls.map(([, request]) => request)).toEqual([
      { operation: "key-info" }, { operation: "enroll" }, { operation: "key-info" }
    ]);
  });

  it("fails closed on generic rejection or identity drift", async () => {
    const rejected = vi.fn().mockRejectedValue(new TrustedHelperRejectedError("rejected"));
    await expect(runOwnerActivationOperation("/app/helper", { operation: "enroll" }, rejected)).rejects.toMatchObject({ reason: "rejected" });

    const drift = vi.fn()
      .mockRejectedValueOnce(new TrustedHelperRejectedError("not-enrolled"))
      .mockResolvedValueOnce({ status: "ok", key_id: keyId })
      .mockResolvedValueOnce({ status: "ok", key_id: "b".repeat(64) });
    await expect(runOwnerActivationOperation("/app/helper", { operation: "enroll" }, drift)).rejects.toThrow(/identity changed/i);
  });
});