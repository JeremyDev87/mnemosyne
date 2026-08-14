import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const DOBBY_PACKAGE_VERSION = "0.2.0rc2";
export const DOBBY_SOURCE_COMMIT = "40870e2a6896df7c41e33d03641e481191e33f72";
export const DOBBY_SEMANTIC_MEMBERS_SHA256 = "4554dfa7c590a019a2a5ae9bf006b481b4e7b066e5bdb9d46e68f307148a9856";
const authoritySchema = z.object({
  schema_version: z.literal(1),
  package_name: z.literal("dobby-wiki-retrieval"),
  package_version: z.literal(DOBBY_PACKAGE_VERSION),
  source_commit: z.literal(DOBBY_SOURCE_COMMIT),
  semantic_members_sha256: z.literal(DOBBY_SEMANTIC_MEMBERS_SHA256),
  wheel_sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(2),
  command_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  python_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  command_mode: z.number().int().nonnegative(),
  signature_mode: z.literal("app-bundle-codesign")
}).strict();

type RuntimeAuthority = z.infer<typeof authoritySchema>;
export type DobbyCommandAdmission = Readonly<{
  command: string;
  runtimeRoot: string;
  authority: RuntimeAuthority;
}>;
export type SignatureVerifier = (appExecutable: string) => Promise<void>;

export class DobbyCommandRejectedError extends Error {
  constructor(reason: string) {
    super(`Bundled Dobby command rejected: ${reason}`);
    this.name = "DobbyCommandRejectedError";
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertOwnerOnlyPath(path: string, expectedUid: number): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current);
    if ((info.mode & 0o022) !== 0) throw new DobbyCommandRejectedError("writable path component");
    if (info.uid !== expectedUid && info.uid !== 0) {
      throw new DobbyCommandRejectedError("owner mismatch");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertImmutableRuntimeTree(root: string, expectedUid: number): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const entry = join(directory, name);
      const info = await lstat(entry);
      if (info.isSymbolicLink()) {
        const link = await readlink(entry);
        if (resolve(link) === link) throw new DobbyCommandRejectedError("runtime symlink is absolute");
        const target = await realpath(resolve(dirname(entry), link)).catch(() => {
          throw new DobbyCommandRejectedError("runtime symlink is dangling");
        });
        if (!inside(root, target)) throw new DobbyCommandRejectedError("runtime symlink escapes root");
        const targetInfo = await lstat(target);
        if (targetInfo.uid !== expectedUid || (targetInfo.mode & 0o022) !== 0) throw new DobbyCommandRejectedError("runtime symlink target is not immutable by policy");
        continue;
      }
      if (info.uid !== expectedUid || (info.mode & 0o022) !== 0) throw new DobbyCommandRejectedError("runtime tree is not immutable by policy");
      if (info.isDirectory()) await visit(entry);
      else if (!info.isFile()) throw new DobbyCommandRejectedError("runtime tree contains special file");
    }
  };
  await visit(root);
}

async function assertRegularFile(path: string, label: string): Promise<string> {
  const resolved = await realpath(path).catch(() => {
    throw new DobbyCommandRejectedError(`${label} is missing`);
  });
  const info = await lstat(resolved);
  if (!info.isFile()) throw new DobbyCommandRejectedError(`${label} is not a regular file`);
  return resolved;
}

function inside(root: string, candidate: string): boolean {
  return candidate !== root && candidate.startsWith(`${root}${sep}`);
}

export async function verifyBundledDobbySignature(appExecutable: string): Promise<void> {
  if (process.platform !== "darwin") throw new DobbyCommandRejectedError("codesign admission requires macOS");
  const macOsDirectory = dirname(resolve(appExecutable));
  const contentsDirectory = dirname(macOsDirectory);
  const appBundle = dirname(contentsDirectory);
  if (basename(macOsDirectory) !== "MacOS" || basename(contentsDirectory) !== "Contents" || !appBundle.endsWith(".app")) {
    throw new DobbyCommandRejectedError("app bundle layout mismatch");
  }
  try {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], {
      timeout: 10_000, maxBuffer: 64 * 1024, shell: false, windowsHide: true
    });
  } catch {
    throw new DobbyCommandRejectedError("app signature verification failed");
  }
}

export async function admitBundledDobbyCommand(options: Readonly<{
  resourcesPath: string;
  appExecutable: string;
  runtimeRoot?: string;
  expectedUid?: number;
  verifySignature?: SignatureVerifier;
}>): Promise<DobbyCommandAdmission> {
  const runtimeRoot = resolve(options.runtimeRoot ?? join(options.resourcesPath, "dobby-runtime"));
  const canonicalRuntimeRoot = await realpath(runtimeRoot).catch(() => {
    throw new DobbyCommandRejectedError("bundled runtime is missing");
  });
  const commandPath = await assertRegularFile(join(runtimeRoot, "bin", "dobby-wiki"), "command");
  const pythonPath = await assertRegularFile(join(runtimeRoot, "python", "bin", "python3"), "python runtime");
  const authorityPath = await assertRegularFile(join(runtimeRoot, "authority.json"), "authority");
  if (!inside(canonicalRuntimeRoot, commandPath) || !inside(canonicalRuntimeRoot, pythonPath) || !inside(canonicalRuntimeRoot, authorityPath)) {
    throw new DobbyCommandRejectedError("runtime path escapes bundled root");
  }
  const expectedUid = options.expectedUid ?? 0;
  await assertOwnerOnlyPath(canonicalRuntimeRoot, expectedUid);
  await assertImmutableRuntimeTree(canonicalRuntimeRoot, expectedUid);
  const commandInfo = await lstat(commandPath);
  const pythonInfo = await lstat(pythonPath);
  if ((commandInfo.mode & 0o111) === 0) throw new DobbyCommandRejectedError("command is not executable");
  if ((pythonInfo.mode & 0o111) === 0) throw new DobbyCommandRejectedError("python runtime is not executable");
  const authority = authoritySchema.parse(JSON.parse(await readFile(authorityPath, "utf8")));
  const executableDigest = await sha256File(commandPath);
  if (executableDigest !== authority.command_sha256) throw new DobbyCommandRejectedError("command digest mismatch");
  if (await sha256File(pythonPath) !== authority.python_sha256) throw new DobbyCommandRejectedError("python runtime digest mismatch");
  if (commandInfo.uid !== expectedUid || pythonInfo.uid !== expectedUid || (commandInfo.mode & 0o777) !== authority.command_mode || (commandInfo.mode & 0o022) !== 0 || (pythonInfo.mode & 0o022) !== 0) {
    throw new DobbyCommandRejectedError("command ownership or mode mismatch");
  }
  await (options.verifySignature ?? verifyBundledDobbySignature)(options.appExecutable);
  return { command: commandPath, runtimeRoot: canonicalRuntimeRoot, authority };
}
