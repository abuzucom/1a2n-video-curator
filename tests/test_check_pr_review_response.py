#!/usr/bin/env python3
"""Test response validation and markdown formatting support."""
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_pr_review_response import ResponseError, validate_response


class CheckPrReviewResponseTest(unittest.TestCase):
    """Validate review response formats, markdown wrappers, and verdicts."""

    def test_standard_clean_response(self):
        body = (
            "Review comments here.\n\n"
            "VERDICT: APPROVE\n"
            'VERDICT_JSON: {"mode": "PR", "verdict": "APPROVE", "findings": []}\n'
        )
        verdict, payload = validate_response(body)
        self.assertEqual(verdict, "APPROVE")
        self.assertEqual(payload["verdict"], "APPROVE")

    def test_markdown_bold_wrapped_verdict(self):
        body = (
            "Review findings.\n\n"
            "**VERDICT:** APPROVE\n"
            '**VERDICT_JSON:** {"mode": "PR", "verdict": "APPROVE", "findings": []}\n'
        )
        verdict, payload = validate_response(body)
        self.assertEqual(verdict, "APPROVE")
        self.assertEqual(payload["mode"], "PR")

    def test_markdown_header_wrapped_verdict(self):
        body = (
            "Summary analysis.\n\n"
            "### VERDICT: NEEDS-HUMAN\n"
            '```json\nVERDICT_JSON: {"mode": "PR", "verdict": "NEEDS-HUMAN", "findings": []}\n```\n'
        )
        verdict, payload = validate_response(body)
        self.assertEqual(verdict, "NEEDS-HUMAN")
        self.assertEqual(payload["verdict"], "NEEDS-HUMAN")

    def test_missing_verdict_line_raises_error(self):
        body = "Only review text without a verdict line.\n"
        with self.assertRaises(ResponseError):
            validate_response(body)


if __name__ == "__main__":
    unittest.main()
