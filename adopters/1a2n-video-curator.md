# 1a2n-video-curator adoption record

## abuzucom/agents adoption

- **Pinned commit:** `e2bec42415f0d918bb807186198290c13f051b4b`
- **AGENTS.md:** Complete 21-rule policy verbatim.
  Repository-specific orientation block replaces upstream source-repo block.
- **Checkers:** Complete set of portable checkers under `scripts/`.
- **Hooks:** Complete gate set under `hooks/` with multi-client configurations
  under `.agents/`, `.claude/`, `.codex/`, and `.gemini/`.
- **Supporting documents:** Adopted under `docs/agent-policy/`.
- **CI:** `sync-check.yml`, `agents-compliance.yml`, and `agents-md-compliance.yml`.
- **Tests:** Complete test suite under `tests/` with `scripts/run_tests.py`
  runner and hook-coverage tooling.

## abuzucom/foucault adoption

- **Pinned commit:** `551a8000a33ba1955d5e9ed79c9f08daacc4ae99`
- **AUDIT.md:** Adopted verbatim and loaded by CI workflows.
- **Workflows:** `security-review-pr.yml`, `security-review.yml`,
  `immutable-conflict-check.yml` implement the PR security review pipeline.
- **Supporting scripts:** `ci/build_pr_case.py`, `ci/call_model.py`,
  `ci/run_model_command.py`, `ci/model_providers.json`,
  `scripts/check_compliance_tree.py`, `scripts/check_pr_review_response.py`.
- **Requirements:** `OLLAMA_API_KEY` (or equivalent model provider key) must
  be set as a GitHub Actions secret for the security review to run.
