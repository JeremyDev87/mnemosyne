export const GIB = 1024 ** 3;
export const R2_WARNING_BYTES = 8 * GIB;
export const R2_BLOCK_BYTES = 10 * GIB;

export function evaluateStorageBudget(currentBytes: number, projectedBytes = currentBytes): { state: "ok" | "warning" | "blocked"; bytes: number; limit: number } {
  if (![currentBytes, projectedBytes].every((bytes) => Number.isFinite(bytes) && bytes >= 0)) {
    throw new Error("currentBytes and projectedBytes must be non-negative finite numbers");
  }
  const bytes = Math.max(currentBytes, projectedBytes);
  if (bytes >= R2_BLOCK_BYTES) return { state: "blocked", bytes, limit: R2_BLOCK_BYTES };
  if (bytes >= R2_WARNING_BYTES) return { state: "warning", bytes, limit: R2_BLOCK_BYTES };
  return { state: "ok", bytes, limit: R2_BLOCK_BYTES };
}
