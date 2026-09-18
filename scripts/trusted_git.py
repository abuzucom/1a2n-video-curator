#!/usr/bin/env python3
"""Resolve and run Git without repository-controlled executable lookup."""
import os
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path

SAFE_CONFIG = (
    "-c",
    "core.pager=",
    "-c",
    "pager.log=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "protocol.ext.allow=never",
)
GITHUB_HOSTS = frozenset(("github.com", "www.github.com"))
AMBIGUOUS_MARKERS = ("$", "`", "%")


def _is_inside(path: Path, directory: Path) -> bool:
    """Return whether `path` is within `directory`."""
    try:
        path_value = os.path.normcase(os.path.abspath(path))
        directory_value = os.path.normcase(os.path.abspath(directory))
        return os.path.commonpath((path_value, directory_value)) == directory_value
    except (ValueError, OSError):
        return False


def _candidate_names() -> tuple[str, ...]:
    """Return executable names accepted for this platform."""
    if os.name == "nt":
        os.environ["NoDefaultCurrentDirectoryInExePath"] = "1"
        return ("git.exe", "git.com")
    return ("git",)


def resolve_git(repo_root) -> str:
    """Return an absolute Git executable outside `repo_root`."""
    repository = Path(repo_root).resolve()
    names = _candidate_names()
    for raw_directory in os.environ.get("PATH", "").split(os.pathsep):
        if not raw_directory:
            continue
        directory = Path(raw_directory.strip('"'))
        if not directory.is_absolute():
            continue
        for name in names:
            candidate = directory / name
            if _is_inside(Path(os.path.abspath(candidate)), repository):
                continue
            try:
                if candidate.is_symlink() or not candidate.is_file():
                    continue
                resolved = candidate.resolve(strict=True)
            except OSError:
                continue
            if _is_inside(resolved, repository):
                continue
            if os.name != "nt" and not os.access(resolved, os.X_OK):
                continue
            return str(resolved)
    raise FileNotFoundError("trusted Git executable was not found on PATH")


def _safe_directory(repository: Path, executable: Path) -> Path:
    """Return an existing execution directory outside the repository."""
    for candidate in (Path(tempfile.gettempdir()), executable.parent):
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if resolved.is_dir() and not _is_inside(resolved, repository):
            return resolved
    raise OSError("no safe external directory is available for Git execution")


def _safe_search_path(repository: Path) -> str:
    """Return PATH without empty, relative, or repository-controlled entries."""
    safe_entries = []
    for raw_directory in os.environ.get("PATH", "").split(os.pathsep):
        if not raw_directory:
            continue
        directory = Path(raw_directory.strip('"'))
        if not directory.is_absolute():
            continue
        try:
            resolved = directory.resolve(strict=False)
        except OSError:
            continue
        if not _is_inside(resolved, repository):
            safe_entries.append(str(resolved))
    return os.pathsep.join(safe_entries)


def _workspace_root(start: Path) -> Path | None:
    """Find the nearest repository root without invoking Git."""
    current = start.resolve()
    while True:
        dot_git = current / ".git"
        if dot_git.is_dir() or dot_git.is_file():
            return current
        parent = current.parent
        if parent == current:
            return None
        current = parent


def run_git(
    repo_root, arguments: list[str], *, input_text=None, check=False,
    runner=None, timeout=None,
):
    """Run trusted Git against `repo_root` from an external directory."""
    repository = Path(repo_root).resolve()
    executable = Path(resolve_git(repository))
    environment = dict(os.environ)
    for name in (
        "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY", "GIT_WORK_TREE",
    ):
        environment.pop(name, None)
    for name in list(environment):
        if name.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            environment.pop(name)
    environment["GIT_PAGER"] = ""
    environment["PAGER"] = ""
    environment["GIT_ATTR_NOSYSTEM"] = "1"
    environment["GIT_NO_LAZY_FETCH"] = "1"
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment["GIT_PROTOCOL_FROM_USER"] = "0"
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["PATH"] = _safe_search_path(repository)
    environment.pop("GIT_EXTERNAL_DIFF", None)
    if os.name == "nt":
        environment["NoDefaultCurrentDirectoryInExePath"] = "1"
    command = [
        str(executable),
        "-C",
        str(repository),
        "--no-pager",
        "--no-replace-objects",
        *SAFE_CONFIG,
        *arguments,
    ]
    execute = runner or subprocess.run
    return execute(
        command,
        cwd=_safe_directory(repository, executable),
        env=environment,
        input=input_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
        timeout=timeout,
    )


def _literal(value: str) -> bool:
    """Return whether a CLI value has no shell expansion markers."""
    return bool(value and not value.startswith("-")
                and not any(marker in value for marker in AMBIGUOUS_MARKERS))


def _github_source(value: str) -> bool:
    """Return whether a clone or fetch source names GitHub safely."""
    if not _literal(value):
        return False
    if value.startswith("git@"):
        ssh_path = value.removeprefix("git@github.com:")
        return (value.startswith("git@github.com:") and bool(ssh_path)
                and "?" not in ssh_path and "#" not in ssh_path)
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
    except ValueError:
        return False
    return (parsed.scheme == "https" and hostname in GITHUB_HOSTS
            and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment
            and bool(parsed.path))


def _workspace_path(workspace: Path, value: str, *, must_exist: bool) -> Path | None:
    """Resolve a literal path inside the current workspace."""
    if not _literal(value):
        return None
    root = workspace.resolve()
    candidate = (root / value).resolve()
    if not _is_inside(candidate, root) or candidate == root:
        return None
    if must_exist and not candidate.is_dir():
        return None
    if not must_exist and candidate.exists():
        return None
    return Path(os.path.abspath(workspace / value))


def _transport_arguments(workspace: Path, arguments: list[str]) -> list[str] | None:
    """Validate the fixed clone and fetch CLI surface."""
    if not arguments or arguments[0] not in {"clone", "fetch"}:
        return None
    operation = arguments[0]
    if operation == "clone":
        if len(arguments) != 3 or not _github_source(arguments[1]):
            return None
        destination = _workspace_path(workspace, arguments[2], must_exist=False)
        if destination is None:
            return None
        return ["clone", "--", arguments[1], str(destination)]
    if len(arguments) < 2:
        return None
    repository = _workspace_path(workspace, arguments[1], must_exist=True)
    if repository is None or not (repository / ".git").exists():
        return None
    remaining = arguments[2:]
    if any(not _literal(value) for value in remaining):
        return None
    return ["-C", str(repository), "fetch", *remaining]


def main(argv: list[str] | None = None) -> int:
    """Run one validated GitHub clone or fetch operation."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    workspace = _workspace_root(Path.cwd())
    if workspace is None:
        print("trusted Git must run inside a repository", file=sys.stderr)
        return 2
    command = _transport_arguments(workspace, arguments)
    if command is None:
        print("usage: trusted_git.py clone <github-url> <new-directory>",
              file=sys.stderr)
        print("       trusted_git.py fetch <repository-directory> [refspec... ]",
              file=sys.stderr)
        return 2
    result = run_git(workspace, command)
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
