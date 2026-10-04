import importlib.util
import tempfile
import tomllib
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("build-agent-assets.py")
SPEC = importlib.util.spec_from_file_location("build_agent_assets", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
compile_assets = MODULE.compile_assets


class BuildAgentAssetsTest(unittest.TestCase):
    def test_compiles_every_agent_and_copies_skills(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        source = repo_root / "agents"

        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "output"
            compile_assets(source, output)

            source_names = {path.stem for path in (source / "agent-files").glob("*.md")}
            self.assertEqual(
                source_names,
                {path.stem for path in (output / "opencode/agents").glob("*.md")},
            )
            self.assertEqual(
                source_names,
                {path.stem for path in (output / "claude/agents").glob("*.md")},
            )
            self.assertEqual(
                source_names,
                {path.stem for path in (output / "codex/agents").glob("*.toml")},
            )

            for path in (output / "codex/agents").glob("*.toml"):
                agent = tomllib.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(path.stem, agent["name"])
                self.assertTrue(agent["description"])
                self.assertIn("Harness compatibility", agent["developer_instructions"])

            for path in (output / "claude/agents").glob("*.md"):
                text = path.read_text(encoding="utf-8")
                self.assertIn(f"name: {path.stem}\n", text)
                self.assertIn("## Harness compatibility", text)

            source_skills = {
                path.relative_to(source / "skills")
                for path in (source / "skills").rglob("*")
                if path.is_file()
            }
            output_skills = {
                path.relative_to(output / "skills")
                for path in (output / "skills").rglob("*")
                if path.is_file()
            }
            self.assertEqual(source_skills, output_skills)


if __name__ == "__main__":
    unittest.main()
