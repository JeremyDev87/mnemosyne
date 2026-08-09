from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CANARY = ROOT / "scripts" / "dobby-read-only-canary.py"


class DobbyReadOnlyCanaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="mnemosyne-canary-test-")
        self.root = Path(self.temp.name)
        self.canonical = self.root / "canonical"
        self.state = self.root / "state"
        self.bin = self.root / "bin"
        self.canonical.mkdir()
        (self.state / "snapshots" / "g1").mkdir(parents=True)
        self.bin.mkdir()
        self.mutation_file = self.root / "mutation.txt"
        self.source = self.canonical / "source.md"
        self.source.write_text("fixture\n", encoding="utf-8")
        manifest = {
            "files": [
                {
                    "relative_path": "source.md",
                    "sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
                    "size": self.source.stat().st_size,
                    "state": "copied",
                }
            ]
        }
        manifest_bytes = json.dumps(manifest, sort_keys=True).encode("utf-8")
        (self.state / "snapshots" / "g1" / "manifest.json").write_bytes(manifest_bytes)
        (self.state / "current.json").write_text(
            json.dumps(
                {
                    "generation": "g1",
                    "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                    "canonical_root": str(self.canonical),
                    "mutation_file": str(self.mutation_file),
                    "schema_version": 2,
                }
            ),
            encoding="utf-8",
        )
        fake = self.bin / "dobby-wiki"
        fake.write_text(
            textwrap.dedent(
                """
                #!/usr/bin/env python3
                import json
                import os
                import sys
                import time
                from pathlib import Path

                args = sys.argv
                state_root = Path(args[args.index("--state-root") + 1])
                current = json.loads((state_root / "current.json").read_text())
                canonical = Path(current["canonical_root"])
                mutation_path = current.get("mutation_file")
                mutation = Path(mutation_path).read_text().strip() if mutation_path and Path(mutation_path).exists() else None
                if mutation == "extra":
                    (canonical / "extra.md").write_text("unexpected\\n")
                elif mutation == "delete":
                    (canonical / "source.md").unlink(missing_ok=True)
                elif mutation == "metadata":
                    os.chmod(canonical / "source.md", 0o600)
                elif mutation == "write-during-command":
                    (canonical / "during-command.md").write_text("written while command ran\\n")
                    time.sleep(0.02)

                common = {"schema_version": 1, "status": "ok", "degraded": False, "mode": "local", "warnings": []}
                if "health" in args:
                    payload = common
                else:
                    payload = {
                        **common,
                        "results": [
                            {
                                "title": "fixture",
                                "path": "source.md",
                                "status": "ok",
                                "source": "fixture",
                                "tier": "P1",
                                "score": 1.0,
                                "rank": 1,
                            }
                        ],
                    }
                print(json.dumps(payload))
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )
        fake.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_canary(self, mutation: str | None = None) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PATH"] = f"{self.bin}{os.pathsep}{env['PATH']}"
        env["MNEMOSYNE_WIKI_STATE_ROOT"] = str(self.state)
        if mutation is not None:
            self.mutation_file.write_text(mutation, encoding="utf-8")
        else:
            self.mutation_file.unlink(missing_ok=True)
        return subprocess.run(
            [sys.executable, str(CANARY)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_blocked(self, mutation: str) -> None:
        result = self.run_canary(mutation)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "blocked")

    def test_clean_canonical_tree_passes(self) -> None:
        result = self.run_canary()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "pass")
        self.assertTrue(payload["canonical_tree_unchanged"])
        self.assertFalse(payload["write_performed"])

    def test_new_file_is_blocked(self) -> None:
        self.assert_blocked("extra")

    def test_deleted_manifest_file_is_blocked(self) -> None:
        self.assert_blocked("delete")

    def test_metadata_change_is_blocked(self) -> None:
        self.assert_blocked("metadata")

    def test_write_during_command_is_blocked(self) -> None:
        self.assert_blocked("write-during-command")


if __name__ == "__main__":
    unittest.main()
