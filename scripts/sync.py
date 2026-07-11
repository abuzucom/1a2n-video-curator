#!/usr/bin/env python3
"""Sync AGENTS.md to the tool-specific instruction file copies.

Usage:
  python3 scripts/sync.py            # overwrite stale copies
  python3 scripts/sync.py --check    # report drift, no writes, exit 1 if stale
"""

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE = REPO_ROOT / "AGENTS.md"
TARGETS = [
    REPO_ROOT / "CLAUDE.md",
    REPO_ROOT / "GEMINI.md",
    REPO_ROOT / "CONVENTIONS.md",
    REPO_ROOT / ".cursorrules",
    REPO_ROOT / ".clinerules",
    REPO_ROOT / ".windsurfrules",
]


def sync_copies(check_only: bool) -> bool:
    """Sync SOURCE content to each stale target. Return True if all are in sync."""
    if not SOURCE.is_file():
        print(f"error: source file not found: {SOURCE}", file=sys.stderr)
        sys.exit(1)

    source_content = SOURCE.read_text()
    all_synced = True

    for target in TARGETS:
        if target.is_file() and target.read_text() == source_content:
            continue

        all_synced = False
        if check_only:
            print(f"stale: {target.relative_to(REPO_ROOT)}")
        else:
            target.write_text(source_content)
            print(f"updated: {target.relative_to(REPO_ROOT)}")

    return all_synced


def main() -> None:
    check_only = "--check" in sys.argv[1:]
    all_synced = sync_copies(check_only)

    if check_only:
        if all_synced:
            print("all copies in sync")
        sys.exit(0 if all_synced else 1)


if __name__ == "__main__":
    main()
