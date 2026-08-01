import { parse as parseYaml } from "yaml";

export type WikiMetadata = Record<string, unknown>;
export type AuthorityKind = "control" | "canonical" | "current" | "redirect" | "evidence";

export interface AuthorityDecision {
  kind: AuthorityKind;
  priority: number;
  answerableAsCurrent: boolean;
  reason: string;
  canonicalPath?: string;
}

export interface WikiDocument {
  path: string;
  title: string;
  body: string;
  metadata: WikiMetadata;
  authority: AuthorityDecision;
}

const truthy = (value: unknown): boolean => value === true || value === "true";
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function classifyAuthority(path: string, metadata: WikiMetadata): AuthorityDecision {
  const normalized = path.replaceAll("\\", "/").normalize("NFC");
  const status = text(metadata.status).toLowerCase();
  const canonicalPath = text(metadata.canonical_path);
  const sourceRole = text(metadata.source_role).toLowerCase();
  const authority = text(metadata.authority).toLowerCase();
  const disallowed = truthy(metadata.do_not_answer_as_current);

  if (status === "redirected") {
    return { kind: "redirect", priority: 50, answerableAsCurrent: false, reason: "redirect alias", ...(canonicalPath ? { canonicalPath } : {}) };
  }

  if (
    normalized === "index.md" || normalized === "log.md" || normalized.startsWith("raw/") ||
    normalized.startsWith("ai-assets/") || normalized.split("/").some((part) => part.startsWith(".")) ||
    ["historical", "superseded", "discarded", "stale"].includes(status) || sourceRole.includes("evidence") || sourceRole.includes("raw")
  ) {
    return { kind: "evidence", priority: 60, answerableAsCurrent: false, reason: "evidence-only namespace or status" };
  }

  if (normalized.startsWith("brain/P0_brainstem/") || normalized.startsWith("brain/P1_cerebellum/") || ["domain_router", "workflow_contract", "answer_compiler"].includes(sourceRole)) {
    return { kind: "control", priority: normalized.startsWith("brain/P0_brainstem/") ? 0 : 10, answerableAsCurrent: !disallowed, reason: "Brain control/authority surface" };
  }

  if (authority === "current" || sourceRole.startsWith("current_")) {
    return { kind: "current", priority: 30, answerableAsCurrent: !disallowed && status !== "inactive", reason: "active current slot" };
  }

  return { kind: "canonical", priority: 20, answerableAsCurrent: !disallowed && !["inactive", "draft"].includes(status), reason: "active canonical/domain page" };
}

export function parseWikiDocument(path: string, content: string): WikiDocument {
  let metadata: WikiMetadata = {};
  let body = content;
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end >= 0) {
      const raw = content.slice(4, end);
      const parsed = parseYaml(raw);
      metadata = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as WikiMetadata : {};
      body = content.slice(end + 5);
    }
  }
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallback = path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
  return { path, title: heading || fallback, body, metadata, authority: classifyAuthority(path, metadata) };
}

export function toFtsQuery(input: string): string {
  const tokens = input.normalize("NFC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.slice(0, 12).map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
}
