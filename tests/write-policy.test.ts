import { describe, expect, it } from "vitest";
import { assertEditablePath, validatePersonalOpsDocument } from "../src/personal-ops/policy";

describe("Personal Ops write policy", () => {
  it("allows only the three current ledgers", () => {
    expect(() => assertEditablePath("brain/P6_prefrontal/personal-ops/tasks.md")).not.toThrow();
    expect(() => assertEditablePath("domains/personal-ops/schedule.md")).not.toThrow();
    expect(() => assertEditablePath("domains/personal-ops/inbox.md")).not.toThrow();
    expect(() => assertEditablePath("brain/P1_cerebellum/personal-ops/SSOT.md")).toThrow(/read-only/i);
    expect(() => assertEditablePath("raw/source.md")).toThrow(/read-only/i);
  });

  it("rejects a done task with no explicit evidence", () => {
    const content = `| ID | Scope | 할일 | 상태 | 우선순위 | 출처 | 다음 액션 |
|---|---|---|---|---|---|---|
| 1 | personal | 테스트 | done | - | 추정 | 없음 |`;
    expect(validatePersonalOpsDocument("brain/P6_prefrontal/personal-ops/tasks.md", content).errors).toContainEqual(expect.objectContaining({ code: "DONE_WITHOUT_EVIDENCE" }));
  });

  it("accepts an evidenced completion", () => {
    const content = `| ID | Scope | 할일 | 상태 | 우선순위 | 출처 | 다음 액션 |
|---|---|---|---|---|---|---|
| 1 | personal | 테스트 | done | - | done: user_explicit 2026-08-01 | 완료 |`;
    expect(validatePersonalOpsDocument("brain/P6_prefrontal/personal-ops/tasks.md", content).errors).toEqual([]);
  });

  it("rejects semantically invalid done evidence and schedule dates", () => {
    const doneWithoutEvidence = `| ID | Scope | 할일 | 상태 | 우선순위 | 출처 | 다음 액션 |
|---|---|---|---|---|---|---|
| 1 | personal | 테스트 | done | - | not done: guessed | 없음 |`;
    const invalidSchedule = `| 날짜/시간 | Scope | 제목 | 상태 | 출처 | 메모 |
|---|---|---|---|---|---|
| not-a-date | personal | 테스트 | confirmed | user_explicit | - |`;
    expect(validatePersonalOpsDocument("brain/P6_prefrontal/personal-ops/tasks.md", doneWithoutEvidence).errors).toContainEqual(expect.objectContaining({ code: "DONE_WITHOUT_EVIDENCE" }));
    expect(validatePersonalOpsDocument("domains/personal-ops/schedule.md", invalidSchedule).errors).toContainEqual(expect.objectContaining({ code: "INVALID_DATE" }));
  });
});
