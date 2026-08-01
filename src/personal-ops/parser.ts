export type Row = Record<string, string>;
export interface IntegrityIssue { code: string; severity: "warning" | "error"; path: string; detail: string }

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((value) => value.replaceAll("\\|", "|").trim());
}

export function parseMarkdownTable(markdown: string): Row[] {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    if (!headerLine?.includes("|") || !separatorLine || !/^\s*\|?\s*:?-{3,}/.test(separatorLine)) continue;
    const headers = cells(headerLine);
    const rows: Row[] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line?.trim().startsWith("|")) break;
      const values = cells(line);
      const row: Row = {};
      headers.forEach((header, cellIndex) => { row[header] = values[cellIndex] ?? ""; });
      rows.push(row);
    }
    return rows;
  }
  return [];
}

const countBy = (rows: Row[], key: string): Record<string, number> => rows.reduce<Record<string, number>>((counts, row) => {
  const value = row[key] || "unknown";
  counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}, {});

const hasDoneEvidence = (row: Row): boolean => {
  const source = `${row["출처"] ?? ""} ${row["메모"] ?? ""} ${row["다음 액션"] ?? ""}`.toLowerCase();
  return source.includes("done:") || source.includes("완료 근거") || source.includes("산출물:");
};

export function buildPersonalOpsSummary(documents: { tasks: string; schedule: string; inbox: string }, now = new Date()) {
  const tasks = parseMarkdownTable(documents.tasks);
  const schedule = parseMarkdownTable(documents.schedule);
  const inbox = parseMarkdownTable(documents.inbox);
  const issues: IntegrityIssue[] = [];
  const validScopes = new Set(["work/remember", "personal", "mixed", "unknown"]);

  for (const row of tasks) {
    const id = row.ID || "unknown";
    if (!validScopes.has(row.Scope ?? "")) issues.push({ code: "INVALID_SCOPE", severity: "error", path: `tasks:${id}`, detail: row.Scope ?? "" });
    if ((row.Scope ?? "") === "unknown") issues.push({ code: "UNKNOWN_SCOPE", severity: "warning", path: `tasks:${id}`, detail: "scope 확인 필요" });
    if ((row["상태"] ?? "") === "done" && !hasDoneEvidence(row)) issues.push({ code: "DONE_WITHOUT_EVIDENCE", severity: "error", path: `tasks:${id}`, detail: "완료 근거가 없습니다" });
  }

  for (const row of schedule) {
    const rawDate = row["날짜/시간"] ?? "";
    const match = rawDate.match(/^\d{4}-\d{2}-\d{2}/);
    if (match && row["상태"] === "tentative") {
      const date = new Date(`${match[0]}T23:59:59+09:00`);
      if (date.getTime() < now.getTime()) issues.push({ code: "PAST_TENTATIVE", severity: "warning", path: `schedule:${rawDate}`, detail: row["제목"] ?? "" });
    }
  }

  const openInbox = inbox.filter((row) => !["triaged", "done", "dropped"].includes((row["상태"] ?? "").toLowerCase())).length;
  return {
    generatedAt: now.toISOString(),
    tasks: { total: tasks.length, byStatus: countBy(tasks, "상태"), byScope: countBy(tasks, "Scope"), rows: tasks },
    schedule: { total: schedule.length, byStatus: countBy(schedule, "상태"), rows: schedule },
    inbox: { total: inbox.length, open: openInbox, rows: inbox },
    issues
  };
}
