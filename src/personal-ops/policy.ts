import { hasDoneEvidence, parseMarkdownTable } from "./parser";

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

function isValidScheduleDate(value: string): boolean {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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
    if (path === "domains/personal-ops/schedule.md" && !isValidScheduleDate(row["날짜/시간"] ?? "")) {
      errors.push({ code: "INVALID_DATE", message: "schedule date must start with a valid ISO date", row: index + 1 });
    }
    if (status === "done" && !hasDoneEvidence(row)) {
      errors.push({ code: "DONE_WITHOUT_EVIDENCE", message: "done requires explicit evidence", row: index + 1 });
    }
    if (scope === "unknown") warnings.push({ code: "UNKNOWN_SCOPE", message: "scope confirmation required", row: index + 1 });
  });
  return { valid: errors.length === 0, errors, warnings };
}
