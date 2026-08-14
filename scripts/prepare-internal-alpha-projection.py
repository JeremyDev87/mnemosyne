#!/usr/bin/env python3
"""Prepare one immutable Mnemosyne projection from verified Dobby state."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import uuid
from pathlib import Path

from dobby_wiki.manifest import load_verified_generation
from dobby_wiki.projection import prepare_projection
import dobby_wiki.projection as projection
from dobby_wiki.lexical import WikimapAdapter
from dobby_wiki.vendor import find_wikimap_path
from dobby_wiki.wikimap_index import _bind_metadata, inspect_index

ALLOW = {"brain", "domains"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def filtered_source(source: Path, root: Path, generation: str) -> None:
    current, verified, manifest = load_verified_generation(source)
    entries = []
    destination = root / "snapshots" / generation
    destination.mkdir(parents=True)
    for entry in manifest["files"]:
        relative = entry["relative_path"]
        if relative.split("/", 1)[0] not in ALLOW:
            continue
        if entry["state"] in {"stale", "quarantined"}:
            raise RuntimeError("unusable knowledge entry in allowlisted corpus")
        copied = dict(entry)
        if entry["state"] == "copied":
            source_path = verified / relative
            target_path = destination / relative
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, target_path)
        entries.append(copied)
    entries.sort(key=lambda item: item["relative_path"])
    filtered = {
        "schema_version": 1,
        "generation": generation,
        "created_at": manifest.get("created_at") or current.get("created_at"),
        "file_count": len(entries),
        "files": entries,
    }
    payload = (json.dumps(filtered, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    (destination / "manifest.json").write_bytes(payload)
    pointer = {
        "schema_version": 1,
        "generation": generation,
        "created_at": filtered["created_at"],
        "manifest_sha256": sha(payload),
    }
    (root / "current.json").write_text(json.dumps(pointer, sort_keys=True) + "\n", encoding="utf-8")


def build_index_allowing_unresolved_links(generation_dir: Path) -> dict:
    vendor = find_wikimap_path(Path(projection.__file__))
    if vendor is None:
        raise RuntimeError("verified Wikimap vendor unavailable")
    manifest_path = generation_dir / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    WikimapAdapter(vendor, generation_dir).index()
    index = generation_dir / ".wikimap" / "index.db"
    expected = {entry["relative_path"] for entry in manifest["files"] if entry["state"] == "copied"}
    with sqlite3.connect(index) as db:
        aliases = {alias.lower(): path for path, alias in db.execute("SELECT path, alias FROM aliases")}
        aliases.update({Path(path).stem.lower(): path for path in expected})
        removals = []
        for rowid, src, dst, kind in db.execute("SELECT rowid, src, dst, kind FROM links"):
            keep = src in expected
            if keep and kind == "md":
                keep = dst in expected
            elif keep and kind == "wiki":
                target = str(dst).replace("\\", "/")
                keep = bool(target) and not target.startswith("/") and "\x00" not in target and ".." not in target.split("/")
                if keep:
                    name = Path(target).name
                    stem = Path(name).stem
                    keep = stem.lower() in aliases
            if not keep:
                removals.append((rowid,))
        db.executemany("DELETE FROM links WHERE rowid=?", removals)
        db.execute("DELETE FROM img_alts WHERE src NOT IN (SELECT path FROM files) OR dst NOT IN (SELECT path FROM files)")
        db.commit()
    _bind_metadata(index, manifest["generation"], sha(manifest_bytes))
    evidence = inspect_index(generation_dir, manifest)
    evidence["excluded_unresolved_link_rows"] = len(removals)
    return evidence


def install_command_view(target: Path, generation: str) -> None:
    """Install a byte-equivalent Dobby CLI view, separate from activation pointer."""
    source = target / "snapshots" / generation
    runtime = target / "runtime"
    destination = runtime / "snapshots" / generation
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=False)
    source_manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    command_manifest = dict(source_manifest)
    command_manifest["schema_version"] = 1
    (destination / "manifest.json").write_text(
        json.dumps(command_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    for entry in source_manifest["files"]:
        if entry["state"] != "copied":
            continue
        relative = entry["relative_path"]
        if (source / relative).read_bytes() != (destination / relative).read_bytes():
            raise RuntimeError("command view differs from attested corpus")
    pointer = runtime / "current.json"
    temporary = runtime / f"current.json.{uuid.uuid4().hex}.tmp"
    manifest_sha256 = sha((source / "manifest.json").read_bytes())
    command_manifest_sha256 = sha((destination / "manifest.json").read_bytes())
    temporary.write_text(json.dumps({
        "schema_version": 1,
        "generation": generation,
        "manifest_sha256": command_manifest_sha256,
        "attested_manifest_sha256": manifest_sha256,
        "authority_sha256": sha((source / "authority.json").read_bytes()),
        "wikimap_index_sha256": sha((source / ".wikimap" / "index.db").read_bytes()),
    }, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, pointer)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-state-root", required=True)
    parser.add_argument("--target-root", required=True)
    parser.add_argument("--generation", required=True)
    args = parser.parse_args()
    source = Path(args.source_state_root).expanduser().resolve()
    target = Path(args.target_root).expanduser().resolve()
    if not args.generation or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-" for ch in args.generation):
        raise SystemExit("invalid generation")
    if (target / "snapshots" / args.generation).exists():
        raise SystemExit("target generation already exists")
    with tempfile.TemporaryDirectory(prefix="mnemosyne-filtered-source-") as source_tmp, tempfile.TemporaryDirectory(prefix="mnemosyne-projection-") as target_tmp:
        filtered_source(source, Path(source_tmp), args.generation)
        original = projection._build_wikimap_index
        projection._build_wikimap_index = build_index_allowing_unresolved_links
        try:
            receipt = prepare_projection(Path(source_tmp), Path(target_tmp))
        finally:
            projection._build_wikimap_index = original
        source_generation = Path(target_tmp) / "snapshots" / args.generation
        snapshots = target / "snapshots"
        snapshots.mkdir(parents=True, exist_ok=True)
        os.rename(source_generation, snapshots / args.generation)
        receipts = target / "projection-receipts"
        receipts.mkdir(parents=True, exist_ok=True)
        (receipts / f"{args.generation}.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        install_command_view(target, args.generation)
        print(json.dumps({
            "status": "ok",
            "generation": args.generation,
            "usable_count": receipt.get("usable_count"),
            "excluded_unresolved_link_rows": receipt.get("wikimap", {}).get("excluded_unresolved_link_rows"),
            "manifest_sha256": receipt.get("manifest_sha256"),
            "authority_sha256": receipt.get("authority_sha256"),
            "wikimap_index_sha256": receipt.get("wikimap_index_sha256"),
        }, sort_keys=True))


if __name__ == "__main__":
    main()
