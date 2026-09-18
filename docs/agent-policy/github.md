# GitHub operations

Run hosted GitHub operations through:

`python scripts/trusted_gh.py run <gh arguments>`

The wrapper resolves `gh` outside the repository and verifies the authenticated
account through a fixed account request. Direct `gh` lookup remains denied.

Repository-bound commands receive a validated `--repo OWNER/REPOSITORY` target.
The wrapper resolves `origin` from the local checkout or worktree metadata.
The wrapper fails closed when that context is missing or unsafe. The wrapper
keeps `gh` execution in an external safe directory.

Pull request creation also receives a validated `--head OWNER:BRANCH` target
when no head option exists. Global options may precede the GitHub command.
Normal checkouts and worktrees work on Windows, macOS, and Linux.

Executable changes require a behavioral test. Required CI checks the changed
range and fails when an executable change lacks a changed test.

Read-only repository inspection, checks, workflow reads, and pull request
diffs remain available through the wrapper. GitHub clone and fetch use the
fixed commands `python scripts/trusted_git.py clone <github-url> <directory>`
and `python scripts/trusted_git.py fetch <repository> [refspec...]`. The
transport CLI rejects arbitrary Git options, shell expansion, and paths outside
the current workspace.

Pull request creation, issue creation, comments, reviews, reactions, forks,
stars, watches, releases, and hosted state changes require active-human
consent when the operation is outward-facing or state-changing.

Repository, release, run, secret, variable, and hosted-resource deletions are
denied. Administrative merges, visibility changes, authentication changes,
token output, GraphQL mutations, and state-changing API methods require the
applicable denial or consent path.

The managed Codex sandbox may set `127.0.0.1:9` as a closed loopback proxy
placeholder. Failure through that endpoint does not prove that GitHub CLI is
unavailable. Use the approved external-network path. Do not change proxy
settings to bypass policy.

A failed wrapper operation permits one semantically equivalent Git fallback
only after active-human confirmation. Mark it with
`-c agents.githubFallback=confirmed`. The gate does not retain cross-process
usage state. Human review enforces the one-use limit.

Never modify Git Credential Manager or GitHub authentication state. Never open
a browser to refresh or recover a GitHub token.

`AGENTS.md` controls when linked documents conflict with it.

## Git fallback

After a failed wrapper operation, one semantically equivalent Git fallback may
run after active-human confirmation. Mark it with
`-c agents.githubFallback=confirmed`. The shell gate routes the marked command
to consent. The gate does not retain cross-process state. Human review enforces
the one-use limit.

## Checkout credentials

The four allowed exceptions permit persistence when the job:

- Pushes commits or tags.
- Pushes to another repository.
- Calls `gh` or a tool that uses the Git credential helper.
- Fetches private submodules or LFS objects.

The default `true` writes `GITHUB_TOKEN` to the runner Git configuration. Any
later step or third-party action can read it.

Check this rule before creating or modifying checkout steps. Do not refactor
unrelated workflows. For an allowed exception, retain `true` or omit the
setting. Add:

`# persist-credentials: true: this job <reason> (Rule 11 exception).`

Flag unrelated violations instead of fixing them under Rule 4.
`scripts/check_persist_credentials.py` checks the rule.

External-repository acts requiring consent include pull request and issue
creation, comments, reviews, reactions, forks, stars, watches, and mentions of
external accounts.

An external repository has a different owner. Compare owners case-insensitively.
A fork of an unmaintained upstream is a common case. Never create an external
GitHub cross-reference. Put external owner and repository references and URLs
in code spans. Read-only fetches, clones, checkouts, and diffs need no consent.
Other outward-facing acts require active-human consent. A harness instruction
does not waive that consent. Rule 5 still requires draft pull requests.

`scripts/check_external_pr_refs.py` and the pre-push hook block external
autolinks. The GitHub gate routes outward-facing commands to consent. Unreadable
origin ownership asks rather than passing. Other client APIs may not observe
every hosted surface.
