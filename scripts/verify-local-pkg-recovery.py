#!/usr/bin/env python3
"""Verify an unsigned Mnemosyne PKG payload in an isolated root.

This never invokes macOS installer(8), writes /Applications or /Library, or
calls the trust helper or launches the production app. It expands the payload,
validates its sealed layout, then simulates copy, remove, identical-copy,
dirty-target refusal, and rollback inside a caller-owned temporary root.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil

import stat
import subprocess
import tempfile

from typing import Iterable

EXPECTED_SOURCE = "40870e2a6896df7c41e33d03641e481191e33f72"
EXPECTED_VERSION = "0.2.0rc2"
EXPECTED_SEMANTIC = "4554dfa7c590a019a2a5ae9bf006b481b4e7b066e5bdb9d46e68f307148a9856"
APP_REL = Path("Applications/Mnemosyne.app")
RUNTIME_REL = Path("Library/Application Support/Mnemosyne/dobby-runtime")


class GateFailure(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_entries(root: Path) -> Iterable[Path]:
    root_real = root.resolve()
    for directory, names, files in os.walk(root, followlinks=False):
        base = Path(directory)
        for name in sorted(names + files):
            path = base / name
            relative = path.relative_to(root)
            if any(part in ("", ".", "..") for part in relative.parts):
                raise GateFailure("payload contains an unsafe relative path")
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(path)
                if os.path.isabs(target):
                    raise GateFailure("payload contains an absolute symlink")
                resolved = (path.parent / target).resolve(strict=False)
                try:
                    resolved.relative_to(root_real)
                except ValueError as error:
                    raise GateFailure("payload symlink escapes root") from error
            elif not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise GateFailure("payload contains a special file")
            yield path


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in safe_entries(root):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        info = path.lstat()
        digest.update(relative + b"\0" + oct(stat.S_IMODE(info.st_mode)).encode("ascii") + b"\0")
        if stat.S_ISLNK(info.st_mode):
            digest.update(b"L\0" + os.readlink(path).encode("utf-8"))
        elif stat.S_ISREG(info.st_mode):
            digest.update(b"F\0" + bytes.fromhex(sha256_file(path)))
        else:
            digest.update(b"D\0")
    return digest.hexdigest()


def verify_payload(payload: Path) -> dict[str, str]:
    entries = list(safe_entries(payload))
    app = payload / APP_REL
    runtime = payload / RUNTIME_REL
    if not app.is_dir() or not runtime.is_dir():
        raise GateFailure("required app or runtime payload is missing")
    for path in entries:
        relative = path.relative_to(payload)
        if relative.parts[0] not in {"Applications", "Library"}:
            raise GateFailure("payload contains an unexpected top-level path")
        if path.name.startswith("._"):
            raise GateFailure("payload contains AppleDouble metadata")
    authority_path = runtime / "authority.json"
    command = runtime / "bin/dobby-wiki"
    python = runtime / "python/bin/python3"
    if not authority_path.is_file() or not command.is_file() or not python.is_file():
        raise GateFailure("sealed runtime files are missing")
    authority = json.loads(authority_path.read_text(encoding="utf-8"))
    expected = {
        "package_version": EXPECTED_VERSION,
        "source_commit": EXPECTED_SOURCE,
        "semantic_members_sha256": EXPECTED_SEMANTIC,
    }
    for key, value in expected.items():
        if authority.get(key) != value:
            raise GateFailure("runtime authority mismatch: " + key)
    if sha256_file(command) != authority.get("command_sha256"):
        raise GateFailure("runtime command digest mismatch")
    if sha256_file(python.resolve()) != authority.get("python_sha256"):
        raise GateFailure("runtime Python digest mismatch")
    for path in safe_entries(runtime):
        if path.lstat().st_mode & 0o022:
            raise GateFailure("runtime payload is group/other writable")
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.jeremywinchester.mnemosyne":
        raise GateFailure("app bundle identifier mismatch")
    return {
        "payload_sha256": tree_digest(payload),
        "runtime_sha256": tree_digest(runtime),
        "command_sha256": authority["command_sha256"],
    }


def copy_payload(payload: Path, target: Path) -> str:
    target.mkdir(parents=True, exist_ok=True)
    if any(target.iterdir()):
        if (target / APP_REL).exists() and (target / RUNTIME_REL).exists() and tree_digest(target) == tree_digest(payload):
            return "identical-noop"
        raise GateFailure("dirty or stale target root rejected")
    for child in payload.iterdir():
        destination = target / child.name
        if child.is_symlink():
            destination.symlink_to(os.readlink(child))
        elif child.is_dir():
            shutil.copytree(child, destination, symlinks=True)
        else:
            shutil.copy2(child, destination, follow_symlinks=False)
    if tree_digest(target) != tree_digest(payload):
        raise GateFailure("installed payload readback mismatch")
    return "installed"


def run_matrix(package: Path) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="mnemosyne-pkg-expand-") as expansion, tempfile.TemporaryDirectory(prefix="mnemosyne-pkg-target-") as target_text:
        expanded = Path(expansion) / "expanded"
        subprocess.run(["/usr/sbin/pkgutil", "--expand-full", str(package), str(expanded)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        payload = expanded / "Payload"
        evidence = verify_payload(payload)
        target = Path(target_text)
        first = copy_payload(payload, target)

        shutil.rmtree(target)
        target.mkdir(mode=0o700)
        removed = not (target / APP_REL).exists() and not (target / RUNTIME_REL).exists()
        second = copy_payload(payload, target)
        reinstall_noop = copy_payload(payload, target)
        shutil.rmtree(target / RUNTIME_REL)
        (target / RUNTIME_REL).mkdir(parents=True)
        (target / RUNTIME_REL / "dirty").write_text("dirty", encoding="utf-8")
        dirty_rejected = False
        try:
            copy_payload(payload, target)
        except GateFailure:
            dirty_rejected = True
        shutil.rmtree(target)
        target.mkdir(mode=0o700)
        copy_payload(payload, target)
        shutil.rmtree(target)
        target.mkdir(mode=0o700)
        rollback_clean = not any(target.iterdir())
        if not (removed and dirty_rejected and rollback_clean):
            raise GateFailure("recovery matrix did not close all gates")
        return {
            "status": "PASS_LOCAL_PKG_PAYLOAD_SIMULATION",
            "package_sha256": sha256_file(package),
            **evidence,
            "first_install": first,
            "production_app_launched": False,
            "installer_invoked": False,
            "remove": "clean" if removed else "failed",
            "reinstall": second,
            "identical_reinstall": reinstall_noop,
            "dirty_install": "rejected" if dirty_rejected else "accepted",
            "rollback": "clean",
            "live_system_mutated": False,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.package.is_file():
        raise GateFailure("package is missing")
    result = run_matrix(args.package.resolve())
    text = json.dumps(result, sort_keys=True, separators=(",", ":"))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (GateFailure, subprocess.CalledProcessError, OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"status": "FAIL_LOCAL_PKG_PAYLOAD_SIMULATION", "reason": str(error)}, sort_keys=True, separators=(",", ":")))
        raise SystemExit(2)
