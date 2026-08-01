import { describe, expect, it } from "vitest";
import { buildPersonalOpsSummary, parseMarkdownTable } from "../src/personal-ops/parser";

const tasks = `# Tasks

| ID | Scope | 할일 | 상태 | 우선순위 | 출처 | 다음 액션 |
|---|---|---|---|---|---|---|
| 20260801-01 | work/remember | 검색 구현 | todo | high | user_explicit | 설계 |
| 20260801-02 | unknown | 완료라고 추정 | done | - | 기억 | 없음 |`;
const schedule = `# Schedule

| 날짜/시간 | Scope | 제목 | 상태 | 출처 | 메모 |
|---|---|---|---|---|---|
| 2026-07-01 | work/remember | 지난 일정 | tentative | user_explicit | 확인 필요 |`;
const inbox = `# Inbox

| 입력 시각 | Scope | 내용 | 후보 분류 | 상태 | 다음 액션 |
|---|---|---|---|---|---|
| 2026-08-01 | personal | 산책 | task | needs-info | 시간 확인 |`;

describe("Personal Ops projection", () => {
  it("parses markdown tables without inventing fields", () => {
    expect(parseMarkdownTable(tasks)[0]).toMatchObject({ ID: "20260801-01", Scope: "work/remember", 상태: "todo" });
  });

  it("separates scopes and reports integrity issues", () => {
    const summary = buildPersonalOpsSummary({ tasks, schedule, inbox }, new Date("2026-08-01T00:00:00Z"));
    expect(summary.tasks.byStatus.todo).toBe(1);
    expect(summary.tasks.byScope["work/remember"]).toBe(1);
    expect(summary.inbox.open).toBe(1);
    expect(summary.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["UNKNOWN_SCOPE", "DONE_WITHOUT_EVIDENCE", "PAST_TENTATIVE"]));
  });
});
