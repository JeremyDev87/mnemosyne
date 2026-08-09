#!/usr/bin/env python3
"""Run a privacy-safe Dobby canary with manifest-backed source integrity checks."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath

STATE_ROOT = Path(os.environ.get("MNEMOSYNE_WIKI_STATE_ROOT", "~/.hermes/state/wiki-retrieval")).expanduser().resolve()
QUERIES = ("personal ops", "schedule inbox tasks")
MAX_RESPONSE_BYTES = 1024 * 1024
GENERATION_RE = re.compile(r"^[A-Za-z0-9._-]+$")
REQUIRED_RESULT_KEYS = {"title", "path", "status", "source", "tier", "score", "rank"}


def executable() -> Path:
    candidate = shutil.which("dobby-wiki")
    if not candidate:
        raise RuntimeError("dobby-wiki executable is unavailable")
    path = Path(candidate).resolve()
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022:
        raise RuntimeError("dobby-wiki executable is not owner-only")
    if os.getuid() not in (0, info.st_uid):
        raise RuntimeError("dobby-wiki executable owner mismatch")
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def state_tree_digest(root: Path) -> str:
    if not root.is_dir():
        raise RuntimeError("Dobby state root is unavailable")
    digest = hashlib.sha256()
    paths = [root, *root.rglob("*")]
    for path in sorted(paths, key=lambda item: b"." if item == root else os.fsencode(item.relative_to(root).as_posix())):
        relative = "." if path == root else path.relative_to(root).as_posix()
        before = path.lstat()
        if stat.S_ISREG(before.st_mode):
            kind = "file"
            content = sha256_file(path)
        elif stat.S_ISDIR(before.st_mode):
            kind = "directory"
            content = ""
        elif stat.S_ISLNK(before.st_mode):
            kind = "symlink"
            content = os.readlink(path)
        else:
            raise RuntimeError("Dobby state root contains an unsupported entry")
        after = path.lstat()
        if (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_dev, after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns
        ):
            raise RuntimeError("Dobby state root changed while fingerprinting")
        digest.update(os.fsencode(relative))
        digest.update(
            f"\0{kind}\0{before.st_dev}\0{before.st_ino}\0{before.st_mode}\0{before.st_uid}\0{before.st_gid}"
            f"\0{before.st_size}\0{before.st_mtime_ns}\0{before.st_ctime_ns}\0{content}\n".encode("utf-8")
        )
    return digest.hexdigest()


def safe_relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\x00" in value:
        raise RuntimeError("manifest path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise RuntimeError("manifest path escapes canonical root")
    return value


def load_manifest() -> tuple[dict, dict, Path]:
    current_path = STATE_ROOT / "current.json"
    current = json.loads(current_path.read_text(encoding="utf-8"))
    generation = current.get("generation")
    manifest_sha = current.get("manifest_sha256")
    canonical_value = current.get("canonical_root")
    if not isinstance(generation, str) or not GENERATION_RE.fullmatch(generation):
        raise RuntimeError("current generation is invalid")
    if not isinstance(manifest_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", manifest_sha):
        raise RuntimeError("current manifest digest is invalid")
    if not isinstance(canonical_value, str):
        raise RuntimeError("canonical root is invalid")
    manifest_path = STATE_ROOT / "snapshots" / generation / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != manifest_sha:
        raise RuntimeError("manifest digest mismatch")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise RuntimeError("manifest has no usable files")
    normalized: dict[str, tuple[str, int]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("manifest entry is invalid")
        relative = safe_relative_path(entry.get("relative_path"))
        digest = entry.get("sha256")
        size = entry.get("size")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise RuntimeError("manifest file digest is invalid")
        if not isinstance(size, int) or size < 0:
            raise RuntimeError("manifest file size is invalid")
        if entry.get("state") != "copied":
            continue
        if relative in normalized:
            raise RuntimeError("manifest path collision")
        normalized[relative] = (digest, size)
    if not normalized:
        raise RuntimeError("manifest has no copied files")
    manifest["files"] = normalized
    return current, manifest, Path(canonical_value).expanduser().resolve()


def source_content_digest(root: Path, expected: dict[str, tuple[str, int]]) -> str:
    if not root.is_dir():
        raise RuntimeError("canonical Wiki root is unavailable")
    digest = hashlib.sha256()
    for relative in sorted(expected):
        expected_sha, expected_size = expected[relative]
        path = root / Path(relative)
        info = path.stat()
        if info.st_size != expected_size:
            raise RuntimeError("canonical file size differs from manifest")
        actual_sha = sha256_file(path)
        if actual_sha != expected_sha:
            raise RuntimeError("canonical file content differs from manifest")
        digest.update(f"{relative}\0{expected_sha}\0{expected_size}\n".encode("utf-8"))
    return digest.hexdigest()


def run(command: Path, *args: str) -> dict:
    env = {
        "HOME": str(Path.home()),
        "WIKI_RETRIEVER": "dobby",
        "PATH": "/usr/bin:/bin",
        "LANG": "C",
        "LC_ALL": "C",
    }
    process = subprocess.Popen(
        [str(command), "--state-root", str(STATE_ROOT), "--pretty", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
        env=env,
    )
    try:
        stdout, stderr = process.communicate(timeout=30)
    except subprocess.TimeoutExpired as exc:
        process.kill()
        process.communicate()
        raise RuntimeError("dobby-wiki timed out") from exc
    if len(stdout) > MAX_RESPONSE_BYTES or len(stderr) > MAX_RESPONSE_BYTES:
        raise RuntimeError("dobby-wiki response exceeded limit")
    if process.returncode != 0:
        raise RuntimeError(f"dobby-wiki failed: exit={process.returncode}")
    try:
        payload = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("dobby-wiki returned malformed JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("dobby-wiki response is not an object")
    return payload


def validate_common(payload: dict) -> None:
    if payload.get("schema_version") != 1 or payload.get("status") != "ok" or payload.get("degraded") is not False:
        raise RuntimeError("dobby-wiki response status/schema is invalid")
    if not isinstance(payload.get("mode"), str) or not isinstance(payload.get("warnings"), list):
        raise RuntimeError("dobby-wiki response fields are invalid")


def validate_health(payload: dict) -> None:
    validate_common(payload)
    if not {"schema_version", "status", "degraded", "mode", "warnings"}.issubset(payload):
        raise RuntimeError("dobby-wiki health response is incomplete")


def validate_search(payload: dict) -> None:
    validate_common(payload)
    results = payload.get("results")
    if not isinstance(results, list):
        raise RuntimeError("dobby-wiki search results are invalid")
    for result in results:
        if not isinstance(result, dict) or not REQUIRED_RESULT_KEYS.issubset(result):
            raise RuntimeError("dobby-wiki search result is incomplete")
        if not isinstance(result["title"], str) or not isinstance(result["path"], str) or not isinstance(result["status"], str):
            raise RuntimeError("dobby-wiki search result types are invalid")


def main() -> int:
    command = executable()
    current, manifest, canonical_root = load_manifest()
    expected = manifest["files"]
    source_before = source_content_digest(canonical_root, expected)
    state_before = state_tree_digest(STATE_ROOT)
    health = run(command, "health")
    validate_health(health)
    searches = [run(command, "-n", "5", "search", query) for query in QUERIES]
    for search in searches:
        validate_search(search)
    source_after = source_content_digest(canonical_root, expected)
    state_after = state_tree_digest(STATE_ROOT)
    source_unchanged = source_before == source_after
    state_unchanged = state_before == state_after
    schema_compatible = current.get("schema_version") == 2
    passed = source_unchanged and state_unchanged and schema_compatible
    summary = {
        "status": "pass" if passed else "blocked",
        "retriever": "dobby",
        "canonical_tree_unchanged": source_unchanged,
        "state_root_unchanged": state_unchanged,
        "projection_schema_compatible": schema_compatible,
        "health_status": health["status"],
        "health_degraded": health["degraded"],
        "query_statuses": [{"status": search["status"], "degraded": search["degraded"], "hit_count": len(search["results"])} for search in searches],
        "write_performed": not state_unchanged,
    }
    print(json.dumps(summary, sort_keys=True))
    return 0 if passed else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "blocked", "retriever": "dobby", "reason": type(exc).__name__, "write_performed": None}, sort_keys=True))
        sys.exit(2)
