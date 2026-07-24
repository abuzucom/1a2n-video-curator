# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Resynced `AGENTS.md` and its tool-specific copies with the current
  `abuzucom/agents` template: added the secrets, dependency-authorization,
  verify-state, and CI `persist-credentials` critical rules, adopted the
  new prose style (no em dashes, `Bad:`/`Good:` markers), and added
  `.copilot-instructions`, `.github/copilot-instructions.md`,
  `scripts/lint_style.py`, `Makefile`, `.pre-commit-config.yaml`,
  `.gitattributes`, and `.editorconfig`. Tooling and documentation only; no
  change to the app itself.

## [1.1.0] - 2026-07-24

### Added
- Native OS folder-picker ("Browse...") for choosing the video folder, with
  a per-session API token and DNS-rebinding protection on the local server.
- Path validation, a `_keep` folder, banned-port enforcement, and a
  zombie-instance fallback when a prior server instance is still running.

### Fixed
- Multiple security hardening fixes: keep-alive race, an overly strict
  `realpath` check, and folder-picker failures on Windows and Linux
  (silent failures, a dialog stuck behind the browser window, and a
  server crash on Windows/Edge).

## [1.0.0] - 2026-07-11

### Added
- Initial local, zero-dependency video triage app: shuffled Keep/Reject/
  Undo review of a folder of videos through a browser UI, auto-mute with
  an unmute toggle, and auto-keep when a video plays to the end.
- Adopted `abuzucom/agents` AI-instruction conventions (`AGENTS.md` and
  synced tool-specific copies).
