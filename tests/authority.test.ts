import { describe, expect, it } from "vitest";
import { classifyAuthority, parseWikiDocument, toFtsQuery } from "../src/wiki/authority";

describe("wiki authority compiler", () => {
  it("routes control, current, redirect, and evidence documents without trusting search rank", () => {
    expect(classifyAuthority("brain/P0_brainstem/CLAUDE.md", { status: "active" }).kind).toBe("control");
    expect(classifyAuthority("brain/P6_prefrontal/personal-ops/tasks.md", { authority: "current" }).kind).toBe("current");
    expect(classifyAuthority("domains/legacy.md", { status: "redirected", canonical_path: "domains/canon.md" })).toMatchObject({ kind: "redirect", canonicalPath: "domains/canon.md" });
    expect(classifyAuthority("raw/source.md", { status: "active" }).kind).toBe("evidence");
    expect(classifyAuthority("index.md", {}).answerableAsCurrent).toBe(false);
  });

  it("parses UTF-8 frontmatter and preserves the body", () => {
    const parsed = parseWikiDocument("domains/personal-ops/sample.md", `---
authority: current
status: active
do_not_answer_as_current: false
---
# 일정

한국어 본문`);
    expect(parsed.title).toBe("일정");
    expect(parsed.body).toContain("한국어 본문");
    expect(parsed.authority.answerableAsCurrent).toBe(true);
  });

  it("turns arbitrary user text into a safe FTS query", () => {
    expect(toFtsQuery(`  일정 OR "drop"  `)).toBe('"일정" AND "OR" AND "drop"');
    expect(toFtsQuery("   ")).toBe("");
  });
});
