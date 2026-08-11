#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
from typing import Any, Callable, NoReturn


def fail(label: str, detail: str = "") -> NoReturn:
    print(f"FAIL_NO_LIVE_ATTESTOR {label}{(': ' + detail) if detail else ''}", file=sys.stderr)
    raise SystemExit(1)


def digest_tree(root: pathlib.Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix().encode()
        if path.is_symlink():
            payload = b"link\0" + relative + b"\0" + os.readlink(path).encode()
        elif path.is_file():
            payload = b"file\0" + relative + b"\0" + path.read_bytes()
        else:
            payload = b"directory\0" + relative
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def trust_digest() -> str:
    result = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", "com.jeremywinchester.mnemosyne.snapshot.trust.v1", "-a", "device"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    return hashlib.sha256(result.stdout + f"\nstatus={result.returncode}\n".encode()).hexdigest()


def main() -> None:
    if len(sys.argv) != 4:
        fail("usage")
    helper, harness, root = map(pathlib.Path, sys.argv[1:])
    home = root / "home"
    generation = "20260811T000000Z-no-live"
    projection = home / "Library/Application Support/Mnemosyne/fixed-projection"
    snapshot = projection / "snapshots" / generation
    environment = {
        "HOME": str(home),
        "MNEMOSYNE_ATTESTOR_TEST_HOME": str(home.resolve()),
        "PATH": "/usr/bin:/bin",
        "LANG": "C",
        "LC_ALL": "C",
    }
    request = {
        "operation": "attest-candidate",
        "generation": generation,
        "sequence": 7,
        "previous_attestation_sha256": "a" * 64,
    }
    documents = {
        "brain/a.md": b"# fixed root\n",
        "domains/redirect.md": b"---\ncanonical_path: brain/a.md\n---\n",
    }
    deleted_path = "domains/deleted.md"

    def sha(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    def valid_manifest() -> dict[str, Any]:
        files = [
            {"relative_path": path, "sha256": sha(data), "size": len(data), "state": "copied"}
            for path, data in documents.items()
        ]
        files.append({"relative_path": deleted_path, "sha256": "0" * 64, "size": 0, "state": "deleted"})
        files.sort(key=lambda entry: entry["relative_path"])
        return {
            "schema_version": 2,
            "generation": generation,
            "created_at": "2026-08-11T00:00:00Z",
            "file_count": len(files),
            "files": files,
        }

    def valid_authority() -> dict[str, Any]:
        return {
            "schema_version": 1,
            "generation": generation,
            "tier_counts": {"unknown": 1, "redirect": 1},
            "redirect_map": {"domains/redirect.md": "brain/a.md"},
            "unresolved_redirects": [],
            "entries": [
                {"relative_path": "brain/a.md", "tier": "unknown", "has_frontmatter": False},
                {
                    "relative_path": "domains/redirect.md",
                    "tier": "redirect",
                    "canonical_path": "brain/a.md",
                    "has_frontmatter": True,
                },
            ],
        }

    def write_json(path: pathlib.Path, value: Any) -> None:
        path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")

    def reset_fixture() -> None:
        if projection.exists():
            shutil.rmtree(projection)
        for relative, data in documents.items():
            path = snapshot / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (snapshot / ".wikimap").mkdir(parents=True, exist_ok=True)
        (snapshot / ".wikimap/index.db").write_bytes(b"fixed-root-index")
        write_json(snapshot / "manifest.json", valid_manifest())
        write_json(snapshot / "authority.json", valid_authority())

    def run(binary: pathlib.Path, payload: bytes) -> subprocess.CompletedProcess[bytes]:
        return subprocess.run([str(binary)], input=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, check=False, timeout=10)

    def run_harness(payload: dict[str, Any] | bytes = request, *, expect_ok: bool, label: str) -> subprocess.CompletedProcess[bytes]:
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode()
        before = digest_tree(projection)
        trust_before = trust_digest()
        result = run(harness, raw)
        if digest_tree(projection) != before or trust_digest() != trust_before:
            fail(label, "candidate validation mutated projection or trust state")
        if expect_ok and result.returncode != 0:
            fail(label, result.stdout.decode(errors="replace"))
        if not expect_ok and (result.returncode == 0 or b'"status":"error"' not in result.stdout):
            fail(label, f"unexpected status={result.returncode} stdout={result.stdout!r}")
        return result

    reset_fixture()
    initial_trust = trust_digest()
    valid = run_harness(expect_ok=True, label="valid-native-authority")
    try:
        decoded = json.loads(valid.stdout)
    except json.JSONDecodeError as exc:
        fail("valid-native-authority-json", str(exc))
    canonical = subprocess.run(
        [str(pathlib.Path.cwd() / "node_modules/.bin/vite-node"), "--script", "scripts/verify-native-canonical.ts"],
        input=valid.stdout,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if canonical.returncode != 0 or canonical.stdout != b"PASS_NATIVE_TYPESCRIPT_CANONICAL_BYTES\n":
        fail("native-typescript-canonical", (canonical.stdout + canonical.stderr).decode(errors="replace"))
    if decoded.get("payload", {}).get("sequence") != 7:
        fail("valid-native-authority-payload")

    unresolved = valid_authority()
    unresolved["entries"][1]["canonical_path"] = "domains/missing"
    unresolved["redirect_map"] = {"domains/redirect.md": "domains/missing"}
    unresolved["unresolved_redirects"] = [{
        "from": "domains/redirect.md",
        "to": "domains/missing",
        "reason": "canonical_path target not found in snapshot",
    }]
    write_json(snapshot / "authority.json", unresolved)
    run_harness(expect_ok=True, label="valid-unresolved-redirect")

    request_cases: list[tuple[str, dict[str, Any] | bytes]] = [
        ("generation-dot", {**request, "generation": "."}),
        ("generation-dotdot", {**request, "generation": ".."}),
        ("sequence-js-overflow", {**request, "sequence": 9_007_199_254_740_992}),
        ("request-unknown", {**request, "root": "/caller-controlled"}),
        ("request-duplicate", json.dumps(request, separators=(",", ":"))[:-1].encode() + b',"sequence":7}'),
    ]
    reset_fixture()
    for label, payload in request_cases:
        run_harness(payload, expect_ok=False, label=label)

    manifest_mutations: list[tuple[str, Callable[[dict[str, Any]], None]]] = [
        ("manifest-unknown", lambda value: value.update(extra=True)),
        ("manifest-generation", lambda value: value.update(generation="other")),
        ("manifest-count", lambda value: value.update(file_count=99)),
        ("manifest-entry-unknown", lambda value: value["files"][0].update(extra=True)),
        ("manifest-state", lambda value: value["files"][0].update(state="stale")),
        ("manifest-copied-sha", lambda value: value["files"][0].update(sha256="f" * 64)),
        ("manifest-deleted-sha", lambda value: next(entry for entry in value["files"] if entry["state"] == "deleted").update(sha256="")),
        ("manifest-deleted-size", lambda value: next(entry for entry in value["files"] if entry["state"] == "deleted").update(size=1)),
        ("manifest-path-dot", lambda value: value["files"][0].update(relative_path="brain/./a.md")),
    ]
    for label, mutate in manifest_mutations:
        reset_fixture()
        value = valid_manifest()
        mutate(value)
        write_json(snapshot / "manifest.json", value)
        run_harness(expect_ok=False, label=label)

    reset_fixture()
    raw_manifest = (snapshot / "manifest.json").read_bytes()
    (snapshot / "manifest.json").write_bytes(raw_manifest[:-1] + b',"file_count":3}')
    run_harness(expect_ok=False, label="manifest-duplicate")

    reset_fixture()
    deleted_file = snapshot / deleted_path
    deleted_file.write_bytes(b"must-not-exist")
    run_harness(expect_ok=False, label="deleted-tombstone-bytes")

    authority_mutations: list[tuple[str, Callable[[dict[str, Any]], None]]] = [
        ("authority-unknown", lambda value: value.update(extra=True)),
        ("authority-generation", lambda value: value.update(generation="other")),
        ("authority-tier-counts-type", lambda value: value.update(tier_counts=[])),
        ("authority-tier-counts-drift", lambda value: value.update(tier_counts={"unknown": 2, "redirect": 0})),
        ("authority-redirect-map", lambda value: value.update(redirect_map={})),
        ("authority-unresolved", lambda value: value.update(unresolved_redirects=[{"from": "domains/redirect.md", "to": "brain/a.md", "reason": "wrong"}])),
        ("authority-entries-count", lambda value: value.update(entries=value["entries"][:-1])),
        ("authority-entry-tier", lambda value: value["entries"][0].update(tier="invented")),
        ("authority-entry-path", lambda value: value["entries"][0].update(relative_path="brain/../a.md")),
        ("authority-entry-type", lambda value: value["entries"][0].update(has_frontmatter="false")),
        ("authority-entry-null", lambda value: value["entries"][0].update(status=None)),
        ("authority-entry-unknown", lambda value: value["entries"][0].update(extra=True)),
    ]
    for label, mutate in authority_mutations:
        reset_fixture()
        value = valid_authority()
        mutate(value)
        write_json(snapshot / "authority.json", value)
        run_harness(expect_ok=False, label=label)

    reset_fixture()
    raw_authority = (snapshot / "authority.json").read_bytes()
    (snapshot / "authority.json").write_bytes(raw_authority[:-1] + b',"generation":"duplicate"}')
    run_harness(expect_ok=False, label="authority-duplicate")

    reset_fixture()
    outside = root / "outside-manifest.json"
    outside.write_bytes((snapshot / "manifest.json").read_bytes())
    (snapshot / "manifest.json").unlink()
    (snapshot / "manifest.json").symlink_to(outside)
    run_harness(expect_ok=False, label="manifest-symlink")

    reset_fixture()
    outside_domains = root / "outside-domains"
    outside_domains.mkdir(exist_ok=True)
    shutil.rmtree(snapshot / "domains")
    (snapshot / "domains").symlink_to(outside_domains, target_is_directory=True)
    run_harness(expect_ok=False, label="component-symlink")

    reset_fixture()
    (snapshot / ".wikimap/index.db").write_bytes(b"")
    run_harness(expect_ok=False, label="wikimap-index-empty")

    reset_fixture()
    os.truncate(snapshot / ".wikimap/index.db", 1024 * 1024 * 1024 + 1)
    run_harness(expect_ok=False, label="wikimap-index-over-1gib")

    reset_fixture()
    invalid_result = run(helper, json.dumps({**request, "root": "/caller-controlled"}).encode())
    if invalid_result.returncode == 0 or b'"status":"error"' not in invalid_result.stdout:
        fail("production-invalid-request")
    standalone = run(helper, json.dumps(request).encode())
    if standalone.returncode == 0 or b'"status":"error"' not in standalone.stdout or b"app caller" not in standalone.stdout:
        fail("production-caller-authorization", standalone.stdout.decode(errors="replace"))
    if trust_digest() != initial_trust:
        fail("trust-state-mutated")

    binary_strings = subprocess.run(["/usr/bin/strings", str(helper)], stdout=subprocess.PIPE, check=False).stdout
    for marker in (
        b"MNEMOSYNE_ATTESTOR_TEST",
        b"MNEMOSYNE_ATTESTOR_TEST_HOME",
        b"canonical_base64",
        b"test harness response encoding failed",
    ):
        if marker in binary_strings:
            fail("production-test-seam-marker", marker.decode())
    source = pathlib.Path("native/trust-helper/main.swift").read_text(encoding="utf-8")
    production_case = source.split('case "attest-candidate":', 1)[1].split("default:", 1)[0]
    if "requireAuthorizedAppCaller()" not in production_case:
        fail("missing-caller-authorization")
    if any(marker in production_case for marker in ("root override", "synthetic signer", "test-harness")):
        fail("production-bypass-marker")

    print("PASS_NO_LIVE_ATTESTOR exact-bytes strict-authority tombstones 1gib-limit max-safe no-follow process-only zero-live-mutation")


if __name__ == "__main__":
    main()
