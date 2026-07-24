#!/usr/bin/env python3
"""Enforce the AGENTS.md dash and ASCII style rules on the source document.

Checks the source (AGENTS.md), not the generated copies, since sync.py keeps
the copies identical. Reports every violation and exits non-zero if any are
found, so CI can block a merge that reintroduces an em-dash substitute or a
stray non-ASCII character in prose.
"""
import re
import sys
from pathlib import Path

SOURCE = "AGENTS.md"
INLINE_CODE = re.compile(r"`[^`]*`")
DASH_SUBSTITUTE = re.compile(r" -{1,3} ")
EM_EN_DASH = re.compile(r"[–—]")


def strip_code(line: str) -> str:
    """Remove inline code spans so hyphens in flags/examples are ignored."""
    return INLINE_CODE.sub("", line)


def find_violations(text: str) -> list[str]:
    """Return one message per style violation in the prose of `text`."""
    violations = []
    in_fence = False
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        prose = strip_code(raw)
        if EM_EN_DASH.search(prose):
            violations.append(f"{SOURCE}:{number}: em/en dash character")
        if DASH_SUBSTITUTE.search(prose):
            violations.append(
                f"{SOURCE}:{number}: spaced hyphen used as an em-dash substitute"
            )
        if any(ord(char) > 127 for char in prose):
            violations.append(f"{SOURCE}:{number}: non-ASCII character in prose")
    return violations


def lint() -> int:
    """Lint the source document. Return 0 when clean, 1 on any violation."""
    root = Path(__file__).resolve().parent.parent
    source = root / SOURCE
    if not source.is_file():
        print(f"error: {SOURCE} not found at {root}", file=sys.stderr)
        return 1

    violations = find_violations(source.read_text(encoding="utf-8"))
    if violations:
        for message in violations:
            print(message, file=sys.stderr)
        print(
            "fix: rewrite as separate sentences or use a comma/colon/semicolon",
            file=sys.stderr,
        )
        return 1
    print("style clean")
    return 0


if __name__ == "__main__":
    sys.exit(lint())
