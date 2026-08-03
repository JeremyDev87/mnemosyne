import { describe, expect, it } from "vitest";
import { R2_BLOCK_BYTES, R2_WARNING_BYTES, evaluateStorageBudget } from "../src/config/budget";

describe("free-tier budget gate", () => {
  it("covers below, exact warning, exact block, and over-block boundaries", () => {
    expect(evaluateStorageBudget(R2_WARNING_BYTES - 1).state).toBe("ok");
    expect(evaluateStorageBudget(R2_WARNING_BYTES).state).toBe("warning");
    expect(evaluateStorageBudget(R2_BLOCK_BYTES).state).toBe("blocked");
    expect(evaluateStorageBudget(R2_BLOCK_BYTES + 1).state).toBe("blocked");
  });

  it("uses the larger of current and projected logical usage", () => {
    expect(evaluateStorageBudget(R2_BLOCK_BYTES, 1).state).toBe("blocked");
    expect(evaluateStorageBudget(1, R2_BLOCK_BYTES).state).toBe("blocked");
  });
});
