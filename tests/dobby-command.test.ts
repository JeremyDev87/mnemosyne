import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitBundledDobbyCommand,
  DobbyCommandRejectedError
} from "../src/wiki/dobby-command";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ resourcesPath: string; appExecutable: string; command: string; authorityPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "mnemosyne-dobby-admission-"));
  roots.push(root);
  const resourcesPath = join(root, "Resources");
  const runtime = join(resourcesPath, "dobby-runtime");
  const command = join(runtime, "bin", "dobby-wiki");
  const authorityPath = join(runtime, "authority.json");
  const appExecutable = join(root, "Mnemosyne.app", "Contents", "MacOS", "Mnemosyne");
  await mkdir(join(runtime, "bin"), { recursive: true });
  await mkdir(join(appExecutable, ".."), { recursive: true });
  await writeFile(command, "#!/bin/sh\nprintf '{\"status\":\"ok\"}'\n");
  await chmod(command, 0o755);
  const commandSha256 = (await import("node:crypto")).createHash("sha256").update(await readFile(command)).digest("hex");
  const pythonPath = join(runtime, "python", "bin", "python3");
  await mkdir(join(runtime, "python", "bin"), { recursive: true });
  await writeFile(pythonPath, "python-runtime");
  await chmod(pythonPath, 0o755);
  const pythonSha256 = (await import("node:crypto")).createHash("sha256").update(await readFile(pythonPath)).digest("hex");
  await writeFile(authorityPath, JSON.stringify({
    schema_version: 1,
    package_name: "dobby-wiki-retrieval",
    package_version: "0.2.0rc2",
    source_commit: "02bd79ab0c86f1b4f79662220b5f1e5d47a9d0a8",
    wheel_sha256: ["a".repeat(64), "a".repeat(64)],
    command_sha256: commandSha256,
    python_sha256: pythonSha256,
    command_mode: 0o755,
    signature_mode: "app-bundle-codesign"
  }));
  await writeFile(appExecutable, "app");
  return { resourcesPath, appExecutable, command, authorityPath };
}

const acceptedSignature = async (): Promise<void> => undefined;

describe("bundled Dobby command admission", () => {
  it("admits only the sealed runtime command and never consults PATH", async () => {
    const candidate = await fixture();
    const admission = await admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    });
    expect(admission.command).toBe(await realpath(candidate.command));
    expect(admission.runtimeRoot).toBe(await realpath(join(candidate.resourcesPath, "dobby-runtime")));
    expect(admission.authority.package_version).toBe("0.2.0rc2");
  });

  it.each([
    ["missing command", async (candidate: Awaited<ReturnType<typeof fixture>>) => { await rm(candidate.command); }],
    ["wrong digest", async (candidate: Awaited<ReturnType<typeof fixture>>) => { await writeFile(candidate.command, "#!/bin/sh\nprintf forged\n"); }],
    ["world-writable command", async (candidate: Awaited<ReturnType<typeof fixture>>) => { await chmod(candidate.command, 0o777); }]
  ])("rejects %s", async (_label, mutate) => {
    const candidate = await fixture();
    await mutate(candidate);
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toBeInstanceOf(DobbyCommandRejectedError);
  });

  it("rejects a runtime outside Resources/dobby-runtime", async () => {
    const candidate = await fixture();
    await expect(admitBundledDobbyCommand({
      resourcesPath: join(candidate.resourcesPath, ".."),
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toBeInstanceOf(DobbyCommandRejectedError);
  });

  it("rejects a post-build command mutation even when the runtime root remains present", async () => {
    const candidate = await fixture();
    await writeFile(candidate.command, "#!/bin/sh\nprintf forged\n");
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toThrow("command digest mismatch");
  });

  it("rejects a post-build Python runtime mutation", async () => {
    const candidate = await fixture();
    await writeFile(join(candidate.resourcesPath, "dobby-runtime", "python", "bin", "python3"), "forged-runtime");
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toThrow("python runtime digest mismatch");
  });

  it("rejects a mutable module-tree file even when command and Python digests match", async () => {
    const candidate = await fixture();
    const modulePath = join(candidate.resourcesPath, "dobby-runtime", "python", "module.py");
    await writeFile(modulePath, "safe = True\n");
    await chmod(modulePath, 0o666);
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toThrow("runtime tree is not immutable by policy");
  });

  it("does not bind authority to the build machine UID", async () => {
    const candidate = await fixture();
    const authority = JSON.parse(await readFile(candidate.authorityPath, "utf8")) as Record<string, unknown>;
    expect(authority).not.toHaveProperty("command_owner_uid");
  });

  it("admits an internal relative Python symlink", async () => {
    const candidate = await fixture();
    const python = join(candidate.resourcesPath, "dobby-runtime", "python", "bin", "python3");
    const target = join(candidate.resourcesPath, "dobby-runtime", "python", "bin", "python3.12");
    await writeFile(target, await readFile(python));
    await chmod(target, 0o755);
    await rm(python);
    await symlink("python3.12", python);
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).resolves.toMatchObject({ command: await realpath(candidate.command) });
  });

  it.each([
    ["absolute", "/bin/sh"],
    ["escaping", "../../../../outside"],
    ["dangling", "missing-python"]
  ])("rejects a %s runtime symlink", async (_label, link) => {
    const candidate = await fixture();
    const python = join(candidate.resourcesPath, "dobby-runtime", "python", "bin", "python3");
    await rm(python);
    await symlink(link, python);
    await expect(admitBundledDobbyCommand({
      resourcesPath: candidate.resourcesPath,
      appExecutable: candidate.appExecutable,
      expectedUid: process.getuid?.() ?? 0,
      verifySignature: acceptedSignature
    })).rejects.toBeInstanceOf(DobbyCommandRejectedError);
  });
});
