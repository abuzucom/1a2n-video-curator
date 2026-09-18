"""Test the blocking SemVer changelog checker."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

CHECKER_PATH = Path(__file__).resolve().parent.parent / "scripts" / "check_changelog.py"


def _load_checker():
    spec = importlib.util.spec_from_file_location("check_changelog", CHECKER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = _load_checker()


class ChangelogCheckerTest(unittest.TestCase):
    """Exercise changelog rules through the checker API."""

    def test_valid_versioned_changelog_passes(self):
        text = """# Changelog\n\n## [2.0.0] (2026-09-13)\n\n### Added\n- Add linked policy loading.\n\n## [1.14.0] (2026-09-12)\n\n### Fixed\n- Fix a gate.\n"""
        self.assertEqual(checker.find_violations(text), [])

    def test_unreleased_heading_fails(self):
        text = "# Changelog\n\n## [Unreleased]\n\n- Pending change.\n"
        findings = checker.find_violations(text)
        self.assertTrue(any("Unreleased" in finding for finding in findings))
        self.assertEqual(sum("line 3:" in finding for finding in findings), 1)

    def test_invalid_version_order_fails(self):
        text = """# Changelog\n\n## [1.0.0] (2026-09-13)\n\n- New.\n\n## [2.0.0] (2026-09-12)\n\n- Old.\n"""
        findings = checker.find_violations(text)
        self.assertTrue(any("descending" in finding for finding in findings))

    def test_missing_versioned_entry_fails(self):
        text = "# Changelog\n\n## [2.0.0] (2026-09-13)\n"
        findings = checker.find_violations(text)
        self.assertTrue(any("entry" in finding for finding in findings))

    def test_malformed_changelog_fails(self):
        findings = checker.find_violations("not a changelog")
        self.assertTrue(any("no versioned" in finding for finding in findings))

    def test_range_requires_version_advance_and_entry(self):
        base = "## [2.0.0] (2026-09-13)\n\n### Added\n- Old.\n"
        findings = checker.find_range_violations(base, base, ["README.md"])
        self.assertTrue(findings)

    def test_range_accepts_new_versioned_entry(self):
        base = "## [2.0.0] (2026-09-13)\n\n### Added\n- Old.\n"
        head = "## [2.0.1] (2026-09-14)\n\n### Fixed\n- New.\n\n" + base
        findings = checker.find_range_violations(
            base, head, ["README.md", "CHANGELOG.md"])
        self.assertEqual(findings, [])

    def test_revision_arguments_reject_options(self):
        self.assertFalse(checker.valid_revision("-s:CHANGELOG.md"))
        self.assertTrue(checker.valid_revision("HEAD~1"))
        self.assertTrue(checker.valid_revision("main^"))

    def test_pre_release_versions_order_and_uniqueness(self):
        text = ("## [1.0.0] (2026-09-14)\n\n- Final.\n"
                "## [1.0.0-rc.1] (2026-09-13)\n\n- RC.\n")
        self.assertEqual(checker.find_violations(text), [])

    def test_undated_release_heading_fails(self):
        findings = checker.find_violations("## [1.0.0]\n\n- Change.\n")
        self.assertTrue(any("invalid version heading" in item for item in findings))

    def test_staged_version_regression_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            (repository / "CHANGELOG.md").write_text(
                "## [1.0.0]\n\n- New.\n", encoding="utf-8")
            self.assertNotEqual(checker.check_staged(repository), 0)


if __name__ == "__main__":
    unittest.main()
