# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] (2026-09-18)

### Added

- Adopted the `abuzucom/viim` brand and visual identity conventions.
- Added self-hosted `Libre Franklin` and `Cousine` WOFF2 fonts served
  directly by `server.js` for offline, zero-dependency typography.
- Implemented `abuzucom/viim` Dark, Grey, and Light theme variants with a
  header theme switcher persisting preference to `localStorage`.
- Styled triage buttons with strict monochromatic visual hierarchy.
- Added immutable cache-control and content-length headers for static font routes.

### Changed

- Replaced non-conforming emojis with text labels.
- Replaced non-conforming prose punctuation with conforming phrasing.

## [1.2.0] (2026-09-18)

### Added

- Integrated `abuzucom/agents` policy source at commit
  `e2bec42415f0d918bb807186198290c13f051b4b`. Adopted `AGENTS.md` 21-rule
  framework with verified project orientation. Added all portable checker
  scripts, agent lifecycle hooks, test suite, and hook-coverage tooling.
  Added multi-client hook configurations for Claude, Codex, Gemini, and
  Antigravity. Added supporting policy documentation under
  `docs/agent-policy/`. Updated `Makefile` with `test`, `identity`, and
  `changelog` targets. Updated `.pre-commit-config.yaml` with local hooks.
  Adopted CI workflows `sync-check.yml`, `agents-compliance.yml`, and
  `agents-md-compliance.yml`.
- Integrated `abuzucom/foucault` PR security review pipeline at commit
  `551a8000a33ba1955d5e9ed79c9f08daacc4ae99`. Added `AUDIT.md` pinned in
  root, `security-review-pr.yml`, `security-review.yml`, and
  `immutable-conflict-check.yml` workflows, `ci/` support scripts, and
  `check_compliance_tree.py` / `check_pr_review_response.py` checkers.
- Created `DRIFT.md` documenting deviations from the upstream template.
- Created `adopters/1a2n-video-curator.md` adoption record.
- Created `upstream-files.json` tracking both upstream repository pins.
- Created `shared-files.json` for gate integrity manifest.

### Changed

- `AGENTS.md` rewritten from 10-rule to 21-rule upstream template with
  repository-specific orientation (Commands, Do not touch, Architecture,
  Gotchas, Read before touching).
- Set `package.json` version to 1.2.0.
- Set the `package.json` `author` field to the GitHub noreply address, so the
  package metadata carries no private address and links to the GitHub account.
- Resynced `AGENTS.md` and its tool-specific copies with the current
  `abuzucom/agents` template: added the secrets, dependency-authorization,
  verify-state, and CI `persist-credentials` critical rules, adopted the
  new prose style (no em dashes, `Bad:`/`Good:` markers), and added
  `.copilot-instructions`, `.github/copilot-instructions.md`,
  `scripts/lint_style.py`, `Makefile`, `.pre-commit-config.yaml`,
  `.gitattributes`, and `.editorconfig`. Tooling and documentation only; no
  change to the app itself.

## [1.1.0] (2026-07-24)

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

## [1.0.0] (2026-07-11)

### Added
- Initial local, zero-dependency video triage app: shuffled Keep/Reject/
  Undo review of a folder of videos through a browser UI, auto-mute with
  an unmute toggle, and auto-keep when a video plays to the end.
- Adopted `abuzucom/agents` AI-instruction conventions (`AGENTS.md` and
  synced tool-specific copies).
