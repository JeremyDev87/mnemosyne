import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseWikiDocument } from "../src/wiki/authority";
import { sha256 } from "../src/wiki/storage";

const root = resolve(import.meta.dirname, "..");
const persist = resolve(root, ".tmp/wrangler");
await mkdir(persist, { recursive: true });
const config = resolve(root, "wrangler.local.jsonc");
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "WIKI_INDEX", "--config", config, "--local", "--persist-to", persist], { cwd: root, stdio: "inherit" });
const fixtures = [
  ["brain/P6_prefrontal/personal-ops/tasks.md", "tests/fixtures/tasks.md"],
  ["domains/personal-ops/schedule.md", "tests/fixtures/schedule.md"],
  ["domains/personal-ops/inbox.md", "tests/fixtures/inbox.md"]
] as const;
const sql: string[] = ["DELETE FROM wiki_fts;", "DELETE FROM wiki_pages;"];
const quote = (value: string | null) => value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
for (const [path, fixture] of fixtures) {
  const file = resolve(root, fixture);
  const content = await readFile(file, "utf8");
  execFileSync("npx", ["wrangler", "r2", "object", "put", `mnemosyne-wiki/shadow/current/${path}`, "--config", config, "--file", file, "--local", "--persist-to", persist], { cwd: root, stdio: "inherit" });
  const document = parseWikiDocument(path, content);
  const hash = await sha256(content);
  sql.push(`INSERT INTO wiki_pages (path,title,body,hash,authority_kind,authority_priority,answerable_as_current,canonical_path,status,source_role,last_verified,indexed_at) VALUES (${quote(path)},${quote(document.title)},${quote(document.body)},${quote(hash)},${quote(document.authority.kind)},${document.authority.priority},${document.authority.answerableAsCurrent ? 1 : 0},${quote(document.authority.canonicalPath ?? null)},'active','fixture','2026-08-01','2026-08-01T00:00:00Z');`);
  sql.push(`INSERT INTO wiki_fts (path,title,body) VALUES (${quote(path)},${quote(document.title)},${quote(document.body)});`);
}
const sqlPath = resolve(root, ".tmp/seed.sql");
await writeFile(sqlPath, sql.join("\n"));
execFileSync("npx", ["wrangler", "d1", "execute", "WIKI_INDEX", "--config", config, "--local", "--persist-to", persist, "--file", sqlPath], { cwd: root, stdio: "inherit" });
console.log(JSON.stringify({ seeded: fixtures.length, persist }));
