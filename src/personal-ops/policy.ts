import { parseMarkdownTable } from "./parser";

export const EDITABLE_PATHS = [
  "brain/P6_prefrontal/personal-ops/tasks.md",
  "domains/personal-ops/schedule.md",
  "domains/personal-ops/inbox.md"
] as const;

export interface ValidationMessage { code: string; message: string; row?: number }
export interface ValidationResult { valid: boolean; errors: ValidationMessage[]; warnings: ValidationMessage[] }

export function assertEditablePath(path: string): asserts path is typeof EDITABLE_PATHS[number] {
  if (!(EDITABLE_PATHS as readonly string[]).includes(path)) throw new Error(`read-only path: ${path}`);
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  "brain/P6_prefrontal/personal-ops/tasks.md": ["ID", "Scope", "할일", "상태", "출처"],
  "domains/personal-ops/schedule.md": ["날짜/시간", "Scope", "제목", "상태", "출처"],
  "domains/personal-ops/inbox.md": ["입력 시각", "Scope", "내용", "상태", "다음 액션"]
};
const SCOPES = new Set(["work/remember", "personal", "mixed", "unknown"]);
const STATUSES: Record<string, Set<string>> = {
  "brain/P6_prefrontal/personal-ops/tasks.md": new Set(["todo", "doing", "blocked", "waiting", "done", "dropped"]),
  "domains/personal-ops/schedule.md": new Set(["tentative", "confirmed", "cancelled", "done"]),
  "domains/personal-ops/inbox.md": new Set(["needs-info", "triaged", "done", "dropped"])
};

export function validatePersonalOpsDocument(path: string, content: string): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  try { assertEditablePath(path); } catch (error) { return { valid: false, errors: [{ code: "READ_ONLY", message: error instanceof Error ? error.message : "read-only" }], warnings }; }
  if (new TextEncoder().encode(content).byteLength > 1024 * 1024) errors.push({ code: "TOO_LARGE", message: "document exceeds 1 MiB" });
  const rows = parseMarkdownTable(content);
  if (rows.length === 0) errors.push({ code: "MISSING_TABLE", message: "Personal Ops table was not found" });
  const required = REQUIRED_COLUMNS[path] ?? [];
  const headers = new Set(Object.keys(rows[0] ?? {}));
  for (const column of required) if (!headers.has(column)) errors.push({ code: "MISSING_COLUMN", message: `missing column: ${column}` });
  rows.forEach((row, index) => {
    const scope = row.Scope ?? "";
    if (!SCOPES.has(scope)) errors.push({ code: "INVALID_SCOPE", message: `invalid scope: ${scope}`, row: index + 1 });
    const status = row["상태"] ?? "";
    if (!STATUSES[path]?.has(status)) errors.push({ code: "INVALID_STATUS", message: `invalid status: ${status}`, row: index + 1 });
    const evidence = `${row["출처"] ?? ""} ${row["메모"] ?? ""} ${row["다음 액션"] ?? ""}`.toLowerCase();
    if (status === "done" && !evidence.includes("done:") && !evidence.includes("완료 근거") && !evidence.includes("산출물:")) {
      errors.push({ code: "DONE_WITHOUT_EVIDENCE", message: "done requires explicit evidence", row: index + 1 });
    }
    if (scope === "unknown") warnings.push({ code: "UNKNOWN_SCOPE", message: "scope confirmation required", row: index + 1 });
  });
  return { valid: errors.length === 0, errors, warnings };
}
