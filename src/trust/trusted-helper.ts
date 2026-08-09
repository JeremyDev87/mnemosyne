import { execFile, spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const TRUSTED_HELPER_IDENTIFIER = "com.jeremywinchester.mnemosyne.trust-helper";
const TRUSTED_APP_IDENTIFIER = "com.jeremywinchester.mnemosyne";
const helperResponseSchema = z.object({
  status: z.literal("ok"),
  key_id: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  public_key_pem: z.string().nullable().optional(),
  signature_base64: z.string().nullable().optional(),
  trust_state: z.object({
    version: z.literal(1),
    key_id: z.string().regex(/^[a-f0-9]{64}$/u),
    accepted_sequence: z.number().int().nonnegative().safe(),
    accepted_attestation_id: z.string().regex(/^[a-f0-9]{64}$/u)
  }).nullable().optional()
}).strict();
const helperFailureSchema = z.object({ status: z.literal("error"), error: z.string().max(256) }).strict();

export type TrustedHelperRequest = Readonly<Record<string, unknown>>;
export type TrustedHelperResponse = z.infer<typeof helperResponseSchema>;
type HelperFileBinding = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; sha256: string }>;
export type CodeSignatureIdentity = Readonly<{ identifier?: string; teamIdentifier?: string }>;
export type TrustedSignatureMode = "local-ad-hoc" | "team-signed";
export type TrustedHelperFailureReason = "invalid-successor" | "rejected";

export class TrustedHelperRejectedError extends Error {
  constructor(readonly reason: TrustedHelperFailureReason) {
    super("Trusted helper rejected request");
    this.name = "TrustedHelperRejectedError";
  }
}

export function parseTrustedHelperFailureReason(output: string): TrustedHelperFailureReason {
  try {
    const failure = helperFailureSchema.parse(JSON.parse(output));
    return failure.error === "trust state successor is invalid" ? "invalid-successor" : "rejected";
  } catch {
    return "rejected";
  }
}

export function assertOwnerOnlyPath(path: string, expectedUid: number | undefined): void {
  let current = path;
  for (;;) {
    const info = lstatSync(current);
    const standardApplicationsDirectory = current === "/Applications" && info.uid === 0 && (info.mode & 0o002) === 0;
    if ((info.mode & 0o002) !== 0 || ((info.mode & 0o020) !== 0 && !standardApplicationsDirectory)) {
      throw new Error("Trusted helper path contains an untrusted writable component");
    }
    if (expectedUid !== undefined && info.uid !== expectedUid && info.uid !== 0) throw new Error("Trusted helper path owner mismatch");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function assertTrustedHelperPath(path: string, expectedUid = process.getuid?.()): string {
  if (process.platform !== "darwin") throw new Error("Secure Enclave helper requires macOS");
  if (!isAbsolute(path)) throw new Error("Trusted helper path must be absolute");
  const resolved = realpathSync(path);
  const info = lstatSync(resolved);
  if (!info.isFile()) throw new Error("Trusted helper must be a regular file");
  if ((info.mode & 0o022) !== 0) throw new Error("Trusted helper is writable by group or other");
  if (expectedUid !== undefined && info.uid !== expectedUid && info.uid !== 0) throw new Error("Trusted helper owner mismatch");
  assertOwnerOnlyPath(dirname(resolved), expectedUid);
  return resolved;
}

function fileBinding(path: string): HelperFileBinding {
  const info = lstatSync(path);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, sha256 };
}

function sameFileBinding(path: string, expected: HelperFileBinding): boolean {
  try {
    const actual = fileBinding(path);
    return actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

function parseCodeSignature(output: string): CodeSignatureIdentity {
  const identifier = /^Identifier=(.+)$/mu.exec(output)?.[1];
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1];
  return { identifier, teamIdentifier };
}

async function codeSignature(path: string): Promise<CodeSignatureIdentity> {
  const result = await execFileAsync("/usr/bin/codesign", ["--display", "--verbose=4", path], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    shell: false,
    windowsHide: true,
    encoding: "utf8"
  });
  return parseCodeSignature(`${result.stdout}\n${result.stderr}`);
}

function normalizedTeamIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return !normalized || normalized === "not set" ? undefined : normalized;
}

export function classifyTrustedSignaturePair(helper: CodeSignatureIdentity, app: CodeSignatureIdentity): TrustedSignatureMode {
  if (helper.identifier !== TRUSTED_HELPER_IDENTIFIER) throw new Error("Trusted helper identifier mismatch");
  if (app.identifier !== TRUSTED_APP_IDENTIFIER) throw new Error("Trusted app identifier mismatch");
  const helperTeam = normalizedTeamIdentifier(helper.teamIdentifier);
  const appTeam = normalizedTeamIdentifier(app.teamIdentifier);
  // Local-only integrity mode detects packaging drift; it is not an identity boundary against a malicious same-UID process that can re-sign binaries.
  if (!helperTeam && !appTeam) return "local-ad-hoc";
  if (!helperTeam || !appTeam || helperTeam !== appTeam) throw new Error("Trusted helper signer identity mismatch");
  return "team-signed";
}

export function assertTrustedBundleLayout(helperPath: string, appExecutablePath: string): void {
  const helperDirectory = dirname(resolve(helperPath));
  const appExecutableDirectory = dirname(resolve(appExecutablePath));
  if (basename(helperDirectory) !== "Resources" || basename(appExecutableDirectory) !== "MacOS") {
    throw new Error("Trusted helper is not inside the packaged app layout");
  }
  const helperContents = dirname(helperDirectory);
  const appContents = dirname(appExecutableDirectory);
  if (helperContents !== appContents || basename(helperContents) !== "Contents" || !dirname(helperContents).endsWith(".app")) {
    throw new Error("Trusted helper and app executable are not co-bundled");
  }
}

async function verifyCodeSignature(path: string): Promise<void> {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", path], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    shell: false,
    windowsHide: true
  });
  const helper = await codeSignature(path);
  const appExecutable = realpathSync(process.execPath);
  const app = await codeSignature(appExecutable);
  assertTrustedBundleLayout(path, appExecutable);
  classifyTrustedSignaturePair(helper, app);
}

function runBinary(path: string, request: TrustedHelperRequest, expectedBinding: HelperFileBinding): Promise<unknown> {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.byteLength > MAX_REQUEST_BYTES) return Promise.reject(new Error("Trusted helper request exceeded limit"));
  if (!sameFileBinding(path, expectedBinding)) return Promise.reject(new Error("Trusted helper changed before execution"));
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
    });
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = (error: Error): void => {
      if (!settled && child && !child.killed) child.kill("SIGKILL");
      finish(error);
    };
    const stdout: Buffer[] = [];
    const timer = setTimeout(() => abort(new Error("Trusted helper timed out")), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) abort(new Error("Trusted helper response exceeded limit"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) abort(new Error("Trusted helper diagnostics exceeded limit"));
    });
    child.stdin.on("error", (error) => abort(error));
    child.once("error", (error) => abort(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new TrustedHelperRejectedError(parseTrustedHelperFailureReason(Buffer.concat(stdout).toString("utf8"))));
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        finish(new Error("Trusted helper returned malformed response"));
      }
    });
    child.stdin.end(input);
  });
}

export async function invokeTrustedHelper(path: string, request: TrustedHelperRequest): Promise<TrustedHelperResponse> {
  const resolved = assertTrustedHelperPath(path);
  const binding = fileBinding(resolved);
  await verifyCodeSignature(resolved);
  return helperResponseSchema.parse(await runBinary(resolved, request, binding));
}
