#!/usr/bin/env python3
"""Track drift between adopted files and abuzucom/agents.

upstream-files.json pins the adopted abuzucom/agents commit and records a
line-ending-normalized SHA-256 for each file copied without local adaptation.
Local adaptations remain in a separate manifest section.

Two modes:
  --check-local     (default) recompute local hashes and compare against the
                     manifest. Catches an accidental local edit to a file
                     that is supposed to track upstream verbatim. No network.
  --check-upstream   compare the manifest's recorded hash for each file
                     against that file's current content in a local checkout
                     of abuzucom/agents (pass --agents-path). Reports which
                     copied files have changed upstream since the pinned
                     commit: the concrete signal for reviewing an upstream
                     change for adoption. Not a pass/fail gate; a nonzero
                     exit means "there is something to review," not "broken."

Usage:
    python scripts/check_upstream_drift.py --check-local
    python scripts/check_upstream_drift.py --check-upstream --agents-path /path/to/agents/checkout
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "upstream-files.json"


def normalized_sha256(path: Path) -> str:
    """Line-ending-normalized SHA-256, matching abuzucom/agents' own
    shared-files.json convention (a Windows checkout must not read as
    drift for line endings alone)."""
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        print(f"error: manifest not found at {MANIFEST_PATH}", file=sys.stderr)
        raise SystemExit(1)
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def check_local(manifest: dict) -> int:
    mismatches = 0
    tracked_files = dict(manifest["files"])
    tracked_files.update(manifest.get("local_adapted_files", {}))
    for rel_path, recorded_hash in sorted(tracked_files.items()):
        local_path = REPO_ROOT / rel_path
        if not local_path.is_file():
            print(f"MISSING  {rel_path}: file not found locally")
            mismatches += 1
            continue
        actual_hash = normalized_sha256(local_path)
        if actual_hash != recorded_hash:
            print(f"DRIFT    {rel_path}: local content does not match the recorded manifest hash")
            mismatches += 1
        else:
            print(f"ok       {rel_path}")
    total = len(tracked_files)
    print(f"\n{total - mismatches}/{total} files match the local manifest")
    return 1 if mismatches else 0


def check_upstream(manifest: dict, agents_path: Path) -> int:
    if not agents_path.is_dir():
        print(f"error: --agents-path {agents_path} is not a directory", file=sys.stderr)
        return 1
    changed = 0
    for rel_path, recorded_hash in sorted(manifest["files"].items()):
        upstream_path = agents_path / rel_path
        if not upstream_path.is_file():
            print(f"REMOVED  {rel_path}: no longer present upstream")
            changed += 1
            continue
        upstream_hash = normalized_sha256(upstream_path)
        if upstream_hash != recorded_hash:
            print(f"CHANGED  {rel_path}: upstream content differs from the pinned commit, review for adoption")
            changed += 1
        else:
            print(f"ok       {rel_path}")
    total = len(manifest["files"])
    print(f"\n{total - changed}/{total} files unchanged upstream since commit {manifest['agents_commit']}")
    if changed:
        print(
            f"\n{changed} file(s) changed upstream. Review each against abuzucom/agents,"
            " decide adopt/decline/adapt, then re-run --write-manifest and update"
            " docs/template-drift.md."
        )
    return 1 if changed else 0


def write_manifest(files: list[str], agents_commit: str) -> None:
    manifest = {
        "agents_repo": "abuzucom/agents",
        "agents_commit": agents_commit,
        "files": {rel: normalized_sha256(REPO_ROOT / rel) for rel in sorted(files)},
        "local_adapted_files": {},
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST_PATH} ({len(files)} files, pinned at {agents_commit})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-local", action="store_true", help="default: recompute and compare local hashes")
    mode.add_argument("--check-upstream", action="store_true", help="compare against a local abuzucom/agents checkout")
    mode.add_argument("--write-manifest", action="store_true", help="regenerate upstream-files.json from --files and --agents-commit")
    parser.add_argument("--agents-path", type=Path, help="local checkout of abuzucom/agents, required for --check-upstream")
    parser.add_argument("--files", nargs="*", help="repo-relative paths to record, required for --write-manifest")
    parser.add_argument("--agents-commit", help="commit SHA to record, required for --write-manifest")
    args = parser.parse_args()

    if args.write_manifest:
        if not args.files or not args.agents_commit:
            print("error: --write-manifest requires --files and --agents-commit", file=sys.stderr)
            return 1
        write_manifest(args.files, args.agents_commit)
        return 0

    manifest = load_manifest()

    if args.check_upstream:
        if not args.agents_path:
            print("error: --check-upstream requires --agents-path", file=sys.stderr)
            return 1
        return check_upstream(manifest, args.agents_path)

    return check_local(manifest)


if __name__ == "__main__":
    raise SystemExit(main())
