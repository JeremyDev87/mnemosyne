import { describe, expect, it } from "vitest";
import { evaluateStorageBudget } from "../src/config/budget";

describe("free-tier budget gate", () => {
  it("warns at 8 GiB and blocks at 10 GiB", () => {
    expect(evaluateStorageBudget(7 * 1024 ** 3).state).toBe("ok");
    expect(evaluateStorageBudget(8 * 1024 ** 3).state).toBe("warning");
    expect(evaluateStorageBudget(10 * 1024 ** 3).state).toBe("blocked");
  });
});
