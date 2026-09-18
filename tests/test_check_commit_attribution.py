#!/usr/bin/env python3
"""Test strict commit identity and co-author validation."""
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
CHECKER_PATH = ROOT / "scripts" / "check_commit_attribution.py"


def load_checker():
    """Load the checker by path for isolated pure-function tests."""
    spec = importlib.util.spec_from_file_location(
        "check_commit_attribution", CHECKER_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def commit(body: str) -> dict:
    """Return the bounded commit shape consumed by trailer validation."""
    return {"sha": "a" * 40, "body": body}


class TrailerTest(unittest.TestCase):
    """Only name-only agent labels and approved human pairs pass."""

    def test_name_only_agent_labels_pass(self):
        checker = load_checker()
        body = (
            "change\n\nCo-authored-by: Codex\n"
            "Co-authored-by: Claude Code\nCo-authored-by: Gemini\n"
        )
        self.assertEqual(checker.trailer_violations([commit(body)]), [])

    def test_agent_email_is_rejected(self):
        checker = load_checker()
        body = "change\n\nCo-authored-by: Codex <codex@openai.com>\n"
        violations = checker.trailer_violations([commit(body)])
        self.assertEqual(len(violations), 1)

    def test_unknown_human_pair_is_rejected(self):
        checker = load_checker()
        body = "change\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n"
        violations = checker.trailer_violations([commit(body)])
        self.assertEqual(len(violations), 1)

    def test_body_lookalike_is_ignored(self):
        checker = load_checker()
        body = (
            "Example text:\n\n"
            "Co-authored-by: Codex <codex@openai.com>\n\n"
            "Keep this example outside terminal trailers.\n"
        )
        self.assertEqual(checker.trailer_violations([commit(body)]), [])


class IdentityTest(unittest.TestCase):
    """Noreply IDs must match the resolved GitHub account."""

    def test_matching_numbered_noreply_identity_passes(self):
        checker = load_checker()
        sha = "b" * 40
        document = {
            "sha": sha,
            "commit": {
                "author": {"email": "123+octocat@users.noreply.github.com"},
                "committer": {"email": "123+octocat@users.noreply.github.com"},
            },
        }
        identity = {"id": 123, "login": "octocat"}
        commit_record = {"sha": sha}
        self.assertIsNone(checker._identity_violation("author", document, identity))
        self.assertIsNone(
            checker._identity_violation("committer", document, identity)
        )
        self.assertEqual(commit_record["sha"], sha)

    def test_mismatched_numbered_noreply_id_fails(self):
        checker = load_checker()
        document = {
            "sha": "c" * 40,
            "commit": {
                "author": {"email": "999+octocat@users.noreply.github.com"},
            },
        }
        identity = {"id": 123, "login": "octocat"}
        violation = checker._identity_violation("author", document, identity)
        self.assertIn("account ID", violation)

    def test_mismatched_numbered_noreply_login_fails(self):
        checker = load_checker()
        document = {
            "sha": "d" * 40,
            "commit": {
                "author": {"email": "123+other@users.noreply.github.com"},
            },
        }
        identity = {"id": 123, "login": "octocat"}
        violation = checker._identity_violation("author", document, identity)
        self.assertIn("login", violation)

    def test_verified_custom_email_passes(self):
        checker = load_checker()
        document = {
            "sha": "e" * 40,
            "commit": {"author": {"email": "author@example.com"}},
        }
        identity = {"id": 123, "login": "octocat"}
        self.assertIsNone(checker._identity_violation("author", document, identity))

    def test_verified_unnumbered_noreply_passes(self):
        checker = load_checker()
        document = {
            "sha": "f" * 40,
            "commit": {
                "author": {"email": "octocat@users.noreply.github.com"},
            },
        }
        identity = {"id": 123, "login": "octocat"}
        self.assertIsNone(checker._identity_violation("author", document, identity))

    def test_unnumbered_noreply_agent_identity_fails(self):
        checker = load_checker()
        document = {
            "sha": "g" * 40,
            "commit": {
                "author": {"email": "octocat@users.noreply.github.com"},
            },
        }
        identity = {"id": 123, "login": "octocat"}
        violation = checker._identity_violation(
            "author", document, identity, require_noreply=True
        )
        self.assertIn("numbered GitHub noreply", violation)


if __name__ == "__main__":
    unittest.main()
