# Codex App Server integration acceptance

Proposal: `ea5285b9-d3a1-4653-8443-ee0a5831c20d`.
Verified 2026-09-28 on **Linux**, Node **22.22.0**, **codex-cli 0.157.1**.
This CLI is the minimum verified baseline; neither earlier nor later versions
were exercised. No macOS/Windows runtime was available in this session.

## Automated acceptance

Run from the repository root:

```sh
env -u CHORUS_AGENT_PROFILE pnpm exec vitest run cli/__tests__
openspec validate switch-codex-daemon-to-app-server --strict
```

Result after aggregate-review fixes: **98 test files, 2403 tests passed**;
strict OpenSpec validation and archive passed.
The test environment deliberately removes the daemon's injected agent profile:
three existing foreground tests require “no profile configured.” This does not
remove the profile from production children or from the real CLI smoke.

The tests in `cli/__tests__/codex-daemon-lifecycle.test.mjs` cross the actual
Waker, control handler, Codex spawner, RPC client, event adapter, session/usage
files, transcript upload hooks, and terminal reporter. Only the child stdio and
HTTP boundary are synthetic. They establish:

- First wake → persisted thread → reconstructed daemon → `thread/resume`; the
  second usage report contains only the new delta.
- Completed item reconciliation produces one complete assistant message, despite
  partial deltas and a duplicate terminal snapshot.
- Definitive missing history triggers one new thread and one uploaded notice.
- Startup/user/shutdown interruption follows the shared control path, rejects a
  wrong connection, emits one correctly classified terminal report, and resumes
  the first interrupted thread. Shutdown suppresses the execution crash report.
- Zero and nonzero exits without a matching terminal event both report a crash.

The spawner/client suites additionally cover deadline/backpressure failure,
unknown native requests, failed/interrupted outcomes, setup and storage failures,
one-time fallback, missing MCP warning-and-run, current permission overrides on
resume, configured model conversion, multi-agent environment isolation, and
missing executables. Existing Claude/Kiro/Pi/dsh/foreground tests all passed.
POSIX group kill, Windows shim and taskkill behavior have injected-platform
contract coverage, including asynchronous taskkill errors, nonzero exits and
timeout within the original cleanup deadline. Taskkill's exit code alone cannot
certify cleanup: subsequent process-identity observations decide whether the
owned processes remain. Session-map I/O regressions verify the approved
warning-and-continue behavior. T2 also exercised a real Linux descendant process group:
cleanup completed in 66 ms with no live descendants.

Aggregate review added eleven setup-identity regressions: a versioned
`thread/started` notification received before the setup response is persisted
once and retained across interruption, including fallback/resume and failed
map writes. A reconstructed spawner resumes that ID; contradictory setup
responses fail without replacing it.

Windows cleanup now takes a noninteractive PowerShell/CIM snapshot **before**
closing stdin, retaining PID plus creation-time identities and parent links.
After root exit it identifies surviving captured descendants, rechecks identities
before targeting `taskkill`, and verifies the result with another snapshot.
An absent root with no remaining descendants succeeds without taskkill.
PID reuse and unrelated processes are excluded. A nonzero taskkill result can
succeed only when the subsequent identity snapshot proves the owned targets
have disappeared; query failure, uncertain initial ownership, residual processes
or deadline expiry fail verification.

Sixteen helper tests, four Windows Waker integration cases and a production
CIM-query/parser-to-spawner regression cover these paths.
The shared stop deadline reserves up to 2.5 seconds (one quarter of the configured
window) for Windows termination checks; it never adds a second timeout window.
System-query output is bounded to 4 MiB and contains only IDs/creation timestamps.
The helper requires Windows PowerShell with `Get-CimInstance` and `taskkill`.
It tracks descendants visible before close and those reachable from captured
parent identities; it does not establish Job Object confinement. This remains
injected Windows contract coverage, **not live Windows certification**.

Microsoft documents the identity fields in
[Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)
and the local query in
[Get-CimInstance for PowerShell 5.1](https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance?view=powershell-5.1).
Both sources are attached to fix task `a8e3467f-be2e-47bd-bc45-fe95e7f40be7`.

## Real installed CLI smoke

The parent ran the production `CodexSpawner` with real subprocesses and isolated
session/usage-map files in a temporary directory. Prompts prohibited repository
edits, Chorus mutations and delegation. Only the integration check requested one
read-only `chorus_checkin` call. The existing Codex config/plugin installation and
its environment-based credentials were used; keys and prompts never entered
the App Server argv.

Execution commands in this session:

```sh
node /tmp/chorus-spawner-live-smoke.mjs
node /tmp/chorus-spawner-yolo-mcp-smoke.mjs
```

These are session-local harnesses, not installed CLI commands. Sanitized observed
results are committed in
[`codex-app-server-live-0.157.1.json`](codex-app-server-live-0.157.1.json).

| Scenario | Observation |
| --- | --- |
| New restricted wake | `initialize`, `initialized`, `thread/start`, one `turn/start`; mapped real thread; exit 0 |
| Next wake with a reconstructed spawner | Same thread via `thread/resume`; recalled `CHORUS_SPAWNER_NEW_928`; exit 0 |
| Old `codex exec` history | Resumed the actual old exec thread; recalled `CHORUS_APP_SERVER_CONTINUITY_928`; exit 0 |
| First-turn interruption | Sent exactly one `turn/interrupt` after `turn/started`; exit 130; thread already persisted |
| Resume after that interruption | Same thread; recalled `CHORUS_FIRST_INTERRUPT_928`; exit 0 |
| Configured YOLO MCP/skills | One `chorus_checkin` MCP item completed; SessionStart hook completed once; model confirmed supplied Chorus skill context |

The restricted new-thread probe also intentionally attempted check-in. Codex
rejected that MCP item as requiring approval under policy `never`; the turn
itself completed normally. With the same installation and YOLO permission mode,
check-in completed. This records the permission boundary rather than claiming
every MCP tool is executable in restricted mode.

The smoke captures `{level, message}` for every logger call and asserts no
warning/error records on configured successful wakes. Explicit transport
`CLOSED` is an informational lifecycle diagnostic; actual transport failures
remain warnings. Two spawner regressions run repeated configured/unconfigured
wakes and assert respectively zero warnings or exactly one missing-MCP warning,
with no error records. Evidence is filtered by recorded severity, not wording.

Every completed real wake emitted one `hook/completed` event with status
`completed`. Therefore no replacement startup/check-in injection was needed.
The interrupted-before-hook wake emitted none, and its next wake ran the hook
once. No missing-MCP or wake-failure warning appeared with the installed config.
The real server also emitted config/status notifications, which are not
conversation text and do not produce duplicate daemon warnings.

These tests do not claim a deployed-daemon rollout or live macOS/Windows
verification. The real CLI smoke covers the production spawner and protocol;
the broader Waker/control/reporting boundary is exercised deterministically by
the automated cross-layer suite. Deployment and any PR push/merge remain outside
this local execution.


## PR #580 review follow-up: silent turns and restricted MCP (2026-09-28)

Task `38bd6777-4e9c-49f2-8736-6bcdc05c695e` removes the turn inactivity
watchdog. Independent review reproduced a real quiet `sleep 45` command being
killed with the former injected 20-second threshold. Production spawner regression
tests now advance one hour without any notifications, then verify normal completion,
manual `turn/interrupt` (exit 130), stdout EOF (failure), and process exit without
terminal (failure). Initialize, thread setup, and turn-start response deadlines
remain bounded. The handshake version is read from the installed `package.json`.

Restricted MCP was compared on Linux using codex-cli 0.157.1. Admin Claude's
independent legacy test used `codex exec --json --sandbox read-only
--skip-git-repo-check`, the same user Codex config and credential environment,
and an empty temporary cwd. Its `chorus/chorus_checkin` tool event failed with
`MCP tool call requires approval, but approval policy is never` (Idea comment
`21b5ec2c-5275-4d9e-b85e-c81d1622325e`). This is evidence for the fresh exec
case, not a claim that legacy resume or every MCP tool was tested.

The follow-up harness ran the production `CodexSpawner` with a temporary cwd,
in-memory session mapping, and `permissionMode: chorus`. For the approved pair
only, its spawn wrapper appended the literal App Server CLI override
`-c 'mcp_servers.chorus.tools.chorus_checkin.approval_mode="approve"'`.
This isolates the Codex configuration rule without editing the user's config;
it is not a supported daemon `args` override. Each pair ran a fresh thread and
then resumed the same thread. The prompt requested exactly one MCP check-in and
prohibited mutations, shell commands, and CLI substitutes. Assertions inspect
`item/completed` → `mcpToolCall`, rather than interpreting exit zero as MCP success.

| Configuration | Fresh thread | Same-thread resume |
| --- | --- | --- |
| Existing config, no `chorus_checkin` allow rule | MCP failed, approval denied | MCP failed, approval denied |
| Check-in `approval_mode = "approve"` override | MCP completed | MCP completed |

All four turns exited zero with no spawner errors. Every setup retained
`approvalPolicy: never` and `sandbox: read-only`; every turn retained
`{type: readOnly, networkAccess: false}`. Structured results are committed in
[codex-restricted-mcp-0.157.1.json](codex-restricted-mcp-0.157.1.json).
The result establishes a tested per-tool option, not blanket access to Chorus
mutation tools. No local sandbox permissions or persistent operator config changed.
