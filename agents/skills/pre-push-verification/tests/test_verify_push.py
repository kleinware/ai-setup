#!/usr/bin/env python3

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "scripts" / "verify_push.py"
LAUNCHER = Path(__file__).parents[1] / "run.sh"


def run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update({"GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
                "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid"})
    return subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


class VerifyPushTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.remote = root / "remote.git"
        self.repo = root / "repo"
        run(root, "git", "init", "--bare", str(self.remote))
        run(root, "git", "init", "-b", "main", str(self.repo))
        run(self.repo, "git", "remote", "add", "origin", str(self.remote))
        (self.repo / "README").write_text("initial\n")
        run(self.repo, "git", "add", "README")
        run(self.repo, "git", "commit", "-m", "project: initial")
        run(self.repo, "git", "push", "-u", "origin", "main")

    def tearDown(self):
        self.temp.cleanup()

    def test_reports_unpushed_secret_without_disclosing_it(self):
        secret = "AKIAABCDEFGHIJKLMNOP"
        (self.repo / "config.txt").write_text(f"key={secret}\n")
        run(self.repo, "git", "add", "config.txt")
        run(self.repo, "git", "commit", "-m", "WIP temporary credentials")
        result = run(self.repo, "python3", str(SCRIPT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Commits in range: 1", result.stdout)
        self.assertIn("AWS access key", result.stdout)
        self.assertIn("appears temporary", result.stdout)
        self.assertNotIn(secret, result.stdout)

    def test_new_branch_falls_back_to_origin_head(self):
        run(self.remote, "git", "symbolic-ref", "HEAD", "refs/heads/main")
        run(self.repo, "git", "remote", "set-head", "origin", "-a")
        run(self.repo, "git", "switch", "-c", "feature")
        (self.repo / "feature").write_text("safe\n")
        run(self.repo, "git", "add", "feature")
        run(self.repo, "git", "commit", "-m", "agents: add feature")
        result = run(self.repo, "python3", str(SCRIPT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Base (exclusive): `origin/main`", result.stdout)
        self.assertIn("Commits in range: 1", result.stdout)

    def test_finds_secret_removed_by_later_commit(self):
        secret = "AKIAABCDEFGHIJKLMNOP"
        target = self.repo / "transient.txt"
        target.write_text(f"{secret}\n")
        run(self.repo, "git", "add", "transient.txt")
        run(self.repo, "git", "commit", "-m", "agents: add transient configuration")
        target.write_text("placeholder\n")
        run(self.repo, "git", "add", "transient.txt")
        run(self.repo, "git", "commit", "-m", "agents: remove transient configuration")
        result = run(self.repo, "python3", str(SCRIPT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AWS access key", result.stdout)
        self.assertNotIn(secret, result.stdout)

    def test_explicit_start_and_end_are_both_included(self):
        first_secret = "AKIAABCDEFGHIJKLMNOP"
        (self.repo / "first.txt").write_text(first_secret + "\n")
        run(self.repo, "git", "add", "first.txt")
        run(self.repo, "git", "commit", "-m", "agents: first endpoint")
        start = run(self.repo, "git", "rev-parse", "HEAD").stdout.strip()
        (self.repo / "middle.txt").write_text("safe\n")
        run(self.repo, "git", "add", "middle.txt")
        run(self.repo, "git", "commit", "-m", "agents: middle")
        (self.repo / "last.txt").write_text("xoxb-1234567890-abcdefghijkl\n")
        run(self.repo, "git", "add", "last.txt")
        run(self.repo, "git", "commit", "-m", "agents: last endpoint")
        end = run(self.repo, "git", "rev-parse", "HEAD").stdout.strip()

        result = run(self.repo, "python3", str(SCRIPT), "--start", start, "--end", end)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Commits in range: 3", result.stdout)
        self.assertIn("Start (inclusive)", result.stdout)
        self.assertIn("End (inclusive)", result.stdout)
        self.assertIn("AWS access key", result.stdout)
        self.assertIn("Slack token", result.stdout)
        self.assertNotIn(first_secret, result.stdout)

    def test_explicit_range_requires_both_endpoints(self):
        result = run(self.repo, "python3", str(SCRIPT), "--start", "HEAD")
        self.assertEqual(result.returncode, 2)
        self.assertIn("must be provided together", result.stderr)

    def test_external_tool_candidates_are_aggregated_and_numbered(self):
        tools = Path(self.temp.name) / "tools"
        tools.mkdir()
        gitleaks = tools / "gitleaks"
        gitleaks.write_text("""#!/usr/bin/env python3
import json, sys
report = sys.argv[sys.argv.index('--report-path') + 1]
json.dump([{'RuleID': 'example-rule', 'Commit': 'abcdef1234567890',
            'File': 'sample.txt', 'StartLine': 7, 'Fingerprint': 'safe-id'}], open(report, 'w'))
""")
        gitleaks.chmod(0o755)
        gitlint = tools / "gitlint"
        gitlint.write_text("#!/bin/sh\necho '1: T1 Title exceeds max length'\nexit 1\n")
        gitlint.chmod(0o755)
        presidio = Path(self.temp.name) / "presidio_analyzer"
        presidio.mkdir()
        (presidio / "__init__.py").write_text("""class Result:
    entity_type = 'PERSON'
    score = 0.91
class AnalyzerEngine:
    def __init__(self, **kwargs): pass
    def analyze(self, text, language, **kwargs):
        return [Result()] if 'Alice Example' in text else []
""")
        (presidio / "nlp_engine.py").write_text("""class NlpEngineProvider:
    def __init__(self, **kwargs): pass
    def create_engine(self): return object()
""")
        (self.repo / "sample.txt").write_text("Alice Example\n")
        run(self.repo, "git", "add", "sample.txt")
        run(self.repo, "git", "commit", "-m", "agents: add sample")
        env = {"PATH": f"{tools}:{os.environ['PATH']}",
               "PYTHONPATH": f"{self.temp.name}:{os.environ.get('PYTHONPATH', '')}"}
        with mock.patch.dict(os.environ, env):
            result = run(self.repo, "python3", str(SCRIPT))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Gitleaks: completed (1 candidate(s))", result.stdout)
        self.assertIn("gitlint: completed (1 candidate(s))", result.stdout)
        self.assertIn("Presidio: completed (1 candidate(s)", result.stdout)
        self.assertIn("[Gitleaks candidate]", result.stdout)
        self.assertIn("[gitlint candidate]", result.stdout)
        self.assertIn("[Presidio PII candidate]", result.stdout)
        self.assertRegex(result.stdout, r"C00[1-9]")

    def test_launcher_reuses_an_isolated_cached_runtime(self):
        skill_dir = LAUNCHER.parent
        digest = __import__("hashlib").sha256(
            b"".join((skill_dir / name).read_bytes() for name in ("requirements.txt", "run.sh"))
        ).hexdigest()[:16]
        cache = Path(self.temp.name) / "cache"
        runtime = cache / digest
        (runtime / "venv" / "bin").mkdir(parents=True)
        (runtime / "bin").mkdir()
        (runtime / ".ready").touch()
        (runtime / "venv" / "bin" / "python").symlink_to(os.sys.executable)
        with mock.patch.dict(os.environ, {"PRE_PUSH_VERIFICATION_CACHE": str(cache)}):
            result = run(self.repo, "bash", str(LAUNCHER), "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--start", result.stdout)
        self.assertNotIn("Preparing isolated", result.stderr)


if __name__ == "__main__":
    unittest.main()
