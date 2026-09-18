# Gate coverage and limits

This document summarizes exercised hook behavior and known limits. Repository
hooks provide advisory controls. The documented controls lack a security
boundary.

## Covered

A model acts through supported tools on POSIX or Windows. Covered attempts
include the following actions:

- The gates classify recursive deletes against every target. Drive roots deny.
  UNC share roots deny. System directories deny. All other targets ask.
- The gates classify filesystem formatting, repair, and raw device writes.
  Covered programs include `mkfs`, `diskpart`, `fdisk`, `fsck`, `dd`, and
  `hdparm`. Coverage also includes a redirect onto a device.
- The gates detect truncating redirects without a delete in the line. Examples
  include `> file` and `cat /dev/null > file`.
- The gates detect pipes into interpreters. Sources include downloads and shell
  history.
- The gates classify history rewrites and published-ref deletion. Covered forms
  include `--force`, `--force-with-lease`, `--mirror`, `--delete`, `--prune`, a
  forced or empty refspec, `--amend`, `rebase`, `filter-branch`, `reset --hard`,
  `branch -D`, and `clean -fdx`.
- The gates classify privilege escalation, process termination, alias
  definition, shell profile writes, schedule destruction, and forge deletion.
- The gates deny cloud, infrastructure-as-code, orchestration, direct SSH,
  file-transfer, and firewall client families across Bash, PowerShell, and CMD.
- The infrastructure file-tool gate denies direct reads and writes to protected
  credentials, Terraform files, and Kubernetes or Helm manifests. Broad Glob
  and Grep requests scan a bounded tree and deny when protected files appear.
- Hosted GitHub operations require `scripts/trusted_gh.py`. The wrapper resolves
  GitHub CLI outside the repository and verifies a fixed authenticated account
  request. Hosted deletions, API writes, GraphQL mutations, administrative
  merges, public visibility, token output, and broad scopes deny.
- Normal merges, repository archives, private visibility changes, and ordinary
  authentication changes ask. Local Git and normal fetch, pull, and push remain
  available. Clear Git and HTTP substitutes for hosted operations deny.
- The gates classify recovery destruction through `vssadmin`, `wbadmin`,
  `wmic shadowcopy`, and `bcdedit`.
- The consent hook gates direct editor-tool writes to existing tests. The same
  hook gates direct editor-tool writes to protected paths under `hooks/` and
  `.claude/`.
- The shell gates classify writes with a recognized redirect or writer target
  that has a test-shaped path. This classification ignores target existence.
- The shell gates classify known Bash and PowerShell writers that target
  `hooks/`, `.claude/`, or `scripts/`. PowerShell named path and destination
  parameters accept valid unambiguous prefixes. The parser reads each parameter
  independently of order.
- The gates classify a git read command in a repository whose effective config
  declares a key naming a program that git runs. Covered read commands include
  `status`, `diff`, `log`, `show`, `blame`, and `grep`. The classifier accounts
  for ordered `-c` settings and leading environment assignments. The classifier
  also accounts for config vectors, path overrides, `GIT_DIR`,
  `GIT_COMMON_DIR`, `-C`, `--git-dir`, `--work-tree`, gitfiles, and
  linked-worktree common config. Repository discovery walks upward from an
  effective `-C` directory on the same device. A depth bound limits discovery.
  `GIT_CONFIG_PARAMETERS` triggers fail-closed handling.
- The gates classify persistent Bash exports and PowerShell environment
  assignments that can make a later git read execute a pager, external diff,
  or configured program. Covered forms include `export`, `declare -x`,
  `typeset -x`, plain PowerShell environment references, braced PowerShell
  environment references, `Set-Item`, and `Set-Variable`.
- The gates classify git commit, git push, and aliases that resolve to those
  operations. The gates read aliases from the effective repository and inline
  config without executing the aliases. Identity checks pass the effective Git
  cwd, repository locations, and inline settings into the checker subprocess.
  Branch checks select checker code from the installed policy root.
  The checks inspect every commit and
  push in a chained command. The checks also inspect every alias that resolves
  to either operation. A possible alias creates ambiguity for an unknown
  subcommand. Unavailable alias sources preserve that ambiguity.
- Strict branch preflight reads bounded Git `HEAD` metadata without launching
  Git. The gate blocks every observable ordinary tool on an invalid branch.
  Active-human question tools remain available. The agent selects one compliant
  correction command. The client requests execution authorization for that
  command. Chaining, wrappers, substitutions, and redirects prevent correction
  clearance. Creation and publication of a `claude/` target also deny from a
  conforming current branch. Bounded repository alias expansion and direct
  writes to `HEAD`, `packed-refs`, branch refs, or linked-worktree metadata also
  deny when the command names that target. Claude stop events block one
  completion attempt on strict failure. An active stop-hook retry allows
  termination without clearing any repository tool.
- Local branch preflight ignores `GITHUB_HEAD_REF`. The optional CI reader
  rejects conflicting named local and environment branches. The fixed branch
  bootstrap remains available from the installed policy root.
- Branch alias inspection runs trusted Git with a fixed configuration-read
  operation. Native Git resolves includes and configuration precedence.
  Invocation settings travel through argument arrays and environment values.
  The config reader accepts only required environment fields. Trace and stream
  redirection controls never reach Git. Fixed environment values disable Trace2
  destinations from Git configuration.
  The inspection never executes an alias. Reads stop at 256 KiB or five seconds.
  Alias expansion stops after ten steps. Unknown and shell aliases deny.
- The branch gate denies opaque interpreters, unlisted scripts, and unresolved
  branch arguments. Commands require an explicit inspectable program name.
  Incomplete parsing receives a syntax denial. Only recovered Git commands
  create ambiguous Git-write contexts. Parsing stops at 65,536 characters.
  Bounded repository workflows request native consent. The route rejects
  wrappers, chained commands, redirection, and shell expansion. Unsupported
  consent responses and unattended Claude sessions remain closed.
- Metadata checks classify the write destination separately from reference
  content. Linked worktrees use resolved administration paths. Unresolved
  directory-root writes deny. Copy target-directory options identify destinations.
  Copy and move destinations cannot contain protected administration directories.
  Unresolved metadata writes deny without claiming a literal prohibited-branch match.
  Git reads receive the same output-redirection checks. Quoted redirection
  operators receive a separate inspection denial. Implicit push targets and
  wrappers with opaque input or execution context also deny.
- Lifecycle hooks read bounded canonical `AGENTS.md` content. Claude injects
  numbered chunks into built-in Explore and Plan agents. Codex injects complete
  context at session and subagent lifecycle events. Gemini and Antigravity
  inject complete context before each model invocation.
- The gates classify commands that one shell passes to another shell. Each
  gate reads both interpreter names. The Bash gate denies `powershell -Command
  'Remove-Item -Recurse -Force /etc'`. The PowerShell gate denies `bash -c 'rm
  -rf /etc'`. The shared core contains POSIX, PowerShell, and CMD delete
  readings. The classifier tries all three readings together.
- The PowerShell gate classifies commands inside script blocks such as
  `& { ... }`. The gate also classifies commands that programs pass through
  `Start-Process -ArgumentList`. Wrapper unwrapping has a bound. Commands past
  the bound deny.
- The PowerShell gate classifies `EncodedCommand` under every supported
  abbreviation and alias. Base64 decoding applies strict validation. UTF-16LE
  decoding also applies strict validation. Every encoded payload denies.
  Missing payloads deny. Malformed payloads deny. Command payloads deny.
- The shared PowerShell policy classifier normalizes recognized aliases and
  parameter forms. File verdicts use path roots, destinations, UNC locations,
  ambiguity, wildcard use, and recursion. Tests vary names and extensions.
  Fixture basenames have no policy meaning.
- The PowerShell policy denies recognized arbitrary execution, remote
  execution, security tampering, credential extraction, persistence, sensitive
  system writes, executable transfer, and outbound data transfer forms.
- A UNC path in command position denies from its remote location. The verdict
  does not depend on the command basename or file extension.
- Upload utilities deny from the selected operation. Curl upload flags support
  separate and attached values. BITS transfer direction distinguishes uploads
  from downloads. Source names and remote endpoints have no policy meaning.
- The PowerShell policy asks for fixed local scripts and process launches.
  It also asks for module operations, bounded administration, broad file
  operations, web reads, credential prompts, and network enumeration.
- The shared classifier applies through Bash, PowerShell, and CMD entry points.
  The strongest nested verdict wins.
- The dedicated CMD parser uses a bounded linear scan for quoting, caret
  escapes, expansion, tokens, and command boundaries. Dynamic expansion and
  malformed syntax deny. Carets inside quotes remain literal. The policy covers
  storage destruction, recursive deletion, redirects, known file writers, Git,
  services, scheduled tasks, interpreters, discovery, and transfer direction.
  PATHEXT names and Windows command paths normalize before classification.
  Tests use synthetic payloads and never launch CMD.
- The platform classifier covers macOS and Linux command families. Tests pass
  the platform explicitly. Each host executes every policy branch. Covered
  operations include storage destruction, persistence, security controls,
  credentials, packages, orchestration, discovery, and transfer direction.

Editor-tool handling resolves the named target with `realpath`. The handler
checks the raw name and resolved name. The handler also checks hard-linked test
inodes. The handler gates test-shaped targets outside the project root. The
shell gates parse command text instead. The shell test-path check uses lexical
analysis. The check handles case variants and alternate data streams. The check
also handles trailing dots or spaces. Shell handling canonicalizes known
protected-path targets. Shell handling omits the editor gate's inode scan.
General shell symlink, hard-link, and short 8.3 handling remain outside the
documented coverage.

The destructive and consent gates deny malformed top-level JSON. The same gates
deny non-object payloads. Branch and identity hooks treat malformed input as an
empty `SessionStart` payload. Applicable tools deny a non-object tool input.
Applicable tools also deny a non-string command or non-null non-string editor
path. A null editor path counts as absent. Existing-test editor paths ask in an
interactive mode. An unrelated malformed field leaves the verdict unchanged.
Examples include a null or numeric `old_string`. An unrecognized
`permission_mode` changes a gated verdict from ask to deny. Calls without a
gated verdict ignore an unrecognized `permission_mode`.

The shared reason builders apply `sanitize` to displayed Git subcommands,
permission modes, environment names, selected program and target names, editor
target basenames, and file-open errors. The function bounds text. The function
renders non-printable and non-ASCII characters visibly. Branch and identity
`SessionStart` warning builders sanitize checker output before placement in
`additionalContext`. Universal output sanitization remains outside the
guarantee. Import-error text remains untrusted output. Checker stderr from
other paths also remains untrusted output.

## Explicit non-goals

Repository hooks operate inside the writable repository. A repository writer
can alter hook source and registration. Tamper resistance requires an external
harness, filesystem isolation, or server-side controls. The template omits
those controls.

Windows Defender Application Control or AppLocker can place PowerShell in
Constrained Language Mode. That operating-system control can restrict dynamic
.NET and COM access outside these hooks. This repository does not configure or
enforce Constrained Language Mode.

- The classifier lacks visibility into commands behind aliases to shell
  functions. The classifier also lacks visibility into wrapper scripts on
  `PATH` and variables holding program names. Unknown writers remain heuristic
  gaps. Write programs with unrecognized parameter shapes remain heuristic
  gaps. Commands with program names hidden in variables remain heuristic gaps.
  A detectable shape fails closed to `ask`. An undetectable shape passes
  unseen.
- Per-call hooks lack telemetry for rate and volume analytics. Examples include
  "N deletions in M minutes" and correlation with an anomalous login. Each gate
  reads one command shape.
- The marked GitHub fallback asks for confirmation. The gate lacks persistent
  cross-process state. Human review enforces the one-use limit after a failed
  trusted wrapper operation.
- Gate registration defines tool coverage. Unregistered tools bypass the gates.
- Codex hosted tools bypass local `PreToolUse` hooks. Claude does not document
  aggregate ordering for parallel subagent policy chunks. Gemini and
  Antigravity do not document hook inheritance for every subagent
  implementation.
- Project hooks require client trust where supported. Client controls can
  disable project hooks. Repository writers can modify every committed hook.
- Hooks cannot enforce Rule 4. A hook sees the proposed action. The hook
  receives the action without a scope statement. The missing scope prevents
  classification of in-scope and out-of-scope changes.
- Content filtering remains outside the goal. The shared gate values above
  receive character rendering and length bounds. Other checker output can
  remain untrusted. Displayed wording never determines authorization.

## Modes and limits

`INTERACTIVE_MODES` lists the `permission_mode` values in which a person can
answer a gated prompt. An unrecognized value denies a gated verdict. The
current behavior correctly handles `bypassPermissions`. A future interactive
mode would also deny. A legitimate gated action would then fail closed. Review
the list when Claude Code adds a mode.

The editor-tool inode walk for hard-linked tests runs only when `st_nlink > 1`.
The walk skips `.git`, `node_modules`, `.venv`, and `__pycache__`. The walk
carries a budget.
Budget exhaustion returns an incomplete result. The caller gates an incomplete
result conservatively. Directory traversal errors also return an incomplete
result. Candidate stat errors produce the same result. An incomplete result
prevents write clearance.

The Python classifiers receive synthetic hook payloads for PowerShell and CMD
coverage. Coverage lacks exercised live PowerShell and CMD tool calls.

## Coverage baseline

The suites run each gate as a subprocess. Tracing uses a `sitecustomize` module
on `PYTHONPATH`. Supported runtimes use local `sys.monitoring` line events when
the coverage tool slot remains available. Other runtimes use a target-scoped
`sys.settrace` fallback. Both implementations record only hook source lines.
The baseline records unreached statements by function. Each entry requires a
reason.

- The `_bash_parser` entries and the Bash and PowerShell parser entries retain
  malformed branches and missing-operand branches. The entries also retain
  alternate `env -S`, direct-caller, and maximum-depth branches. Subprocess
  entry points reject some branches earlier. Other branches require syntactic
  forms outside the regression corpus.
- The Git config and repository-discovery helpers, including
  `_apply_git_config_argument`, `_apply_git_path_argument`,
  `_environment_config`, `_parent_repository_dir`, and
  `_read_invocation_configs`, retain bounds and missing optional files. The
  helpers also retain invalid-key and filesystem-error arms. The suite exercises
  representative fail-closed classes and executable settings. Equivalent arms
  remain outside coverage.
- The commit and push context helpers, `git_checker_environment`,
  `_alias_write_label`, `_shell_alias_write_label`, and both enforcement
  handlers retain malformed global options. The same functions retain
  alias-depth variants and shell-alias variants. Absent config sources and
  error-reporting arms also remain.
- `_is_system_root`, `_mentions_device`,
  `_segment_program`, `device_write_verdict`, `forge_verdict`,
  `logging_verdict`, `mass_operation_verdict`, `posix_delete_verdict`,
  `remote_execution_verdict`, `schedule_verdict`, `unparseable_verdict`, and
  `volume_verdict` retain platform, device, mount, and uncommon-program arms.
  Corpus rows exercise representative outcomes. The corpus avoids building
  real devices or mounts.
- `_protected_path` uses an explicit `ntpath` cross-drive case. Linux and
  Windows therefore reach the same defensive `ValueError` branch.
- `_pages_deployment_path_verdict` and the added path-validation statements in
  `cloudflare_pages_verdict` retain four tracer-unreached statements. The
  Cloudflare regression tests exercise these branches through direct verdicts,
  persistent shell gates, and a fresh Bash subprocess. The coverage runner
  still records no trace for these four statements. Keep the measured limit in
  the baseline until the subprocess tracer can attribute this import path.
- `is_test_path` retains alternate Windows path-component and drive-relative
  arms. Representative test-shaped and ordinary paths cover each verdict.
- `su_target_verdict` retains malformed option sequences, unsupported option
  operands, and direct-caller token shapes. Corpus rows cover missing, root,
  fixed non-root, dynamic, and command-payload targets.
- `_cmd_parser` functions retain empty-segment, terminal-caret, unmatched
  expansion, size-bound, and malformed direct-caller arms. Synthetic CMD rows
  cover complete, dynamic, malformed, empty, and bounded command parsing.
- `_platform_policy` functions retain alternate endpoint syntax and uncommon
  macOS or Linux program-family arms. Cross-host tests cover every verdict and
  representative programs without invoking native platform tools.
- `block_destructive_cmd` classifiers retain missing operands, alternate curl
  flags, service query forms, and direct-caller parse states. Synthetic payloads
  cover destructive, persistence, discovery, transfer, and interpreter paths.
- The PowerShell `_interpreter_verdict` retains an uncommon parser state after
  a recognized interpreter. Shared corpus rows cover fixed scripts, command
  payloads, dynamic targets, and plain shell transitions.
- Branch enforcement retains malformed lifecycle payloads and uncommon Git target positions in
  `alias_names_prohibited_branch`, `command_names_prohibited_branch`,
  `command_names_prohibited_metadata`, `handle_context_event`, and `main`.
  Hook tests cover every lifecycle event and client consent response.
  Tests also cover exact recovery, aliases, metadata, and branch publication.
- `read_payload`, `resolved_under`, and `sanitize` retain defensive exceptions
  and direct-caller bounds. Hook entry points reject those states earlier.
- `_branch_from_git_directory` retains the post-resolution containment check for a replaced
  or linked `.git/HEAD`. A portable test cannot create that filesystem race.
- `load_policy` retains the post-read size check for policy growth after
  `lstat`. A deterministic test cannot create that filesystem race.
- The consent entries retain cross-drive path handling, absent path fields, and
  the top-level exception boundary. Narrow OS-boundary tests cover out-of-tree
  paths and open errors. The tests also cover the hard-link budget and ordinary
  denial paths.

CI runs `scripts/check_hook_coverage.py`. The script compares the run against
`hook-coverage-baseline.json`. Per-function counts prevent churn from edits
above a function. The script fails when a function gains unreached statements.
Such statements represent new code outside test coverage. The script also fails
when a function loses unreached statements. Such a loss marks a stale baseline.
The checker runs each test class in a separate process. Up to four workers run
concurrently. The scheduler submits only enough shards to fill active workers.
It stops submission after the first failure. It terminates active process trees
before joining workers. Measured long-running shards start first. Resource-heavy
shards run alone. Ordinary shards use every worker after that lane completes.
Classifier-heavy suites reuse one hook process within each isolated class
process. Selected CLI suites reuse one loaded entrypoint and restore argv,
stdin, cwd, and environment after every request. Fresh-process smoke cases
retain process-entrypoint coverage. Start notices, completion notices, and
10-second heartbeats expose progress. A 30-second ordinary per-class timeout
and a 180-second resource-heavy timeout terminate the process tree and fail the
check. Coverage comparison starts only after every worker succeeds.

Every baseline entry requires a reason in this document. An unexplained entry
represents untested code. A recorded exception requires an explanation.

The baseline tool conservatively refuses baseline writes as root.
Permission-mode tests use real files. Narrow patches at `os.open` and `os.stat`
exercise error boundaries independently of account privileges. Windows and
Linux therefore record the same consent-hook branches.
