# dsh npm-only acceptance

## Result

PASS for the npm-only migration.

This record combines fresh package/composition checks performed on 2026-08-18
with the existing real DeepSeek-backed wake evidence captured against the same
pinned dsh revision. The provider-backed wake was not repeated during the
migration rerun.

## Baseline

- Chorus repository base revision: `55f5cd6272e38c74d89bb8e68fedbf967bbd5093`
- DeepSeek Harness revision:
  `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
  (`dsh-v0.1.0-rc.7`)
- Package under test: a local tarball produced from
  `packages/chorus-dsh`
- Platform class: Linux x86_64

Credential values, authorization headers, and provider secrets are intentionally
absent from this report.

## Fresh interactive acceptance

Command:

```text
pnpm --filter @chorus-aidlc/chorus-dsh run test:dsh-smoke
```

Result: PASS, 1 file and 3 assertions.

The test packed the local npm package, installed it with the pinned dsh CLI into
an isolated profile, and verified:

- profile dependency and bundle reconciliation;
- resolution of `@deepseek-ai/dsh-mcp-client`,
  `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-tool-skill`, and
  `@deepseek-ai/dsh-persona`;
- package-local inline persona and instructions;
- the package-local executable MCP wrapper;
- exactly these 14 packaged skills:
  `chorus`, `idea-chorus`, `proposal-chorus`, `develop-chorus`,
  `yolo-chorus`, `review-chorus`, `quick-dev-chorus`,
  `brainstorm-chorus`, `openspec-aware-chorus`, `orchestrate-chorus`,
  `docs-chorus`, `proposal-reviewer-chorus`, `task-reviewer-chorus`, and
  `code-reviewer-chorus`;
- no Chorus-owned copied tree beneath the isolated dsh home.

## Fresh daemon composition acceptance

A local tarball was passed to `prepareManagedDshConfig` with isolated Chorus
state and a sentinel dsh home. The real managed installer completed, and the
installed `dsh-jsonrpc-agent` completed JSON-RPC `initialize`.

Result: PASS.

The acceptance probe verified:

- all five imports loaded from the generated config's resolution anchor:
  `@chorus-aidlc/chorus-dsh` plus the four peers listed above;
- the Chorus bundle resolved by package name;
- the colocated rc.7 JSON-RPC runtime was installed;
- the package-local MCP wrapper was present and executable;
- the generated config, managed `package.json`, and active-state marker did not
  contain the injected credential sentinel;
- the sentinel dsh home remained absent.

The managed files were created under isolated Chorus-owned state, not under a
dsh profile.

## Real wake evidence

The earlier provider-backed acceptance used the same pinned dsh commit and a
real foreground Chorus daemon. It established:

- successful Chorus connection registration with client type `dsh`;
- real check-in and Chorus MCP workflow through a dedicated local fixture;
- committed user and assistant transcript messages;
- one terminal normalized usage record with model and source attribution;
- a fresh dsh backend session for each accepted wake;
- user interruption reported as `interrupted(user)`;
- SIGINT delivered through the process-group boundary, with the observed
  runtime and child process gone within 573 ms;
- no post-terminal transcript or usage duplication.

The original restart-continuity run exposed a session/backend-ID conflict. That
contract was subsequently corrected by the backend-session change in this
integration worktree. Restart continuity is not an acceptance condition of the
npm distribution migration and is not represented as a fresh live rerun here.

## Focused regression checks

Fresh command:

```text
pnpm exec vitest run \
  cli/__tests__/dsh-spawner.test.mjs \
  cli/__tests__/dsh-backend-integration.test.mjs \
  cli/__tests__/transcript-upload-hooks.test.mjs \
  cli/__tests__/waker-turn-lifecycle.test.mjs \
  cli/__tests__/process-killer.test.mjs \
  cli/__tests__/daemon-integration.test.mjs \
  cli/__tests__/daemon-shutdown-signal.test.mjs
```

Result: PASS, 7 files and 136 tests. The daemon integration suite was run with
a clean temporary `HOME` so the machine's active daemon configuration could not
affect its entry-point assertions.

Coverage includes JSON-RPC spawning, managed-config selection, committed dsh
transcript extraction, per-Idea usage attribution, user/shutdown interruption,
process-tree termination, and graceful daemon shutdown.

Additional fresh checks:

- package build, tests, static package validation, and packed-tarball validation:
  PASS;
- onboarding component test for npm commands and prerequisites: PASS;
- repository TypeScript check: PASS;
- repository diff whitespace check: PASS;
- OpenSpec strict validation: PASS.

## Distribution and secret audit

The repository no longer contains the hosted dsh installer, its installer
tests, the copied public delivery tree, or build references to that tree.
Onboarding and English, Chinese, Japanese, and Korean locale copy use the npm
profile-add flow and require dsh plus pnpm. The English and Chinese connection
guides describe interactive peer ownership, daemon-managed bundle-plus-peer
installation, explicit config overrides, environment credentials, and zero
Chorus writes beneath the dsh home.

Package files, generated config, recorded command output, and this report were
checked for credential values and authorization material. No credential value
is recorded in files, argv evidence, or logs.
