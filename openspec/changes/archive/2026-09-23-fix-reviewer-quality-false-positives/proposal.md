# Fix two false-positive generators, machine-enforce Kiro's read-only shell, resync a stale prohibition

## Why

An independent review of `97b8faba..e9d09116` returned FAIL on four findings. All four are confirmed.

**Two of the new quality dimensions classify by mechanism instead of by capability, so they fire on correct code.**

`tests that cannot fail` treats "asserts only that a mock was called" as a BLOCKER. But when the acceptance criterion *is* about invocation — a callback runs exactly once, a handler is not called on the error path — asserting the call is direct verification of that contract. A call-count assertion fails if the callback is removed or runs twice, so it is exactly the test that dimension wants. Classifying by "uses a mock" is the wrong axis.

`silent failure` treats "an error logged then discarded" and "a failure path that returns success" as BLOCKERs outright. That fires on deliberate degradation. This repository contains the counterexample: `cli/kiro-spawner.mjs` runs transcript reconstruction as documented "post-run, best-effort" work that "never throws into the wake path", logging what it could not do. Flagging that is a false positive — and the repository's own no-silent-errors principle asks for *visibility*, which the log provides, not for refusing to degrade.

**The Kiro permission premise was factually wrong, and it was used to justify a weaker posture.** The previous change asserted that Kiro's `tools` is a flat name list with no per-command allow-list, and on that basis accepted read-only-ness resting on the prompt alone. Kiro's configuration reference lists `permissions` as a valid top-level agent key, with `rules` carrying `capability` / `match` / `effect` / `exclude`; the older `toolsSettings.shell.allowedCommands` form is deprecated as of CLI 3.0 and kept only for MCP tool settings. So the middle option existed. Worse, the conclusion was backwards: Kiro is the *only* surface whose grant is declarative, so it is the only one where read-only-ness can be machine-enforced rather than merely instructed.

**A cumulative spec still forbids what the implementation now requires.** `reviewer-finding-identity` still states that the `code-reviewer` NOT-DO list SHALL exclude "escalating a conclusion reached only by reading code to BLOCKER severity", which commit `a53c53c3` deliberately reversed. This is the fourth instance of an implementation change landing without resyncing an already-archived spec.

## What Changes

**Dimension 4 — reframed as a mutation question.** All seven task-reviewer definitions ask "would this test fail if the behaviour were implemented wrongly?" and raise a BLOCKER only when the answer is no, explicitly regardless of whether a mock is involved, with the call-count-as-contract case named.

**Dimension 5 — scoped to required operations.** Silent failure blocks only where a required operation's failure is masked or a stated error contract is violated. Explicitly optional or best-effort work whose failure is recorded and which is designed not to propagate is excluded, with the no-silent-errors principle restated as being about visibility.

**Kiro reviewers gain machine-enforced `permissions.rules`** — a `deny` on `fs_write`, and `deny` rules on `shell` covering file writes, git write operations, package installs, privilege escalation and mutating HTTP verbs; the proposal reviewer additionally denies common test and build runners, since its review precedes implementation. Rules are **deny-only**: an allow-list would have to name project-specific test and build commands, and these templates install into arbitrary repositories. The prompt's prohibited-command list stays the contract on all seven surfaces; this is defence in depth on the one surface that can enforce it.

**The stale prohibition is replaced** with the evidence-matched-to-claim rule the implementation actually carries.

## Capabilities

- `task-review-default-quality` — MODIFIED: dimensions 4 and 5.
- `kiro-plugin-templates` — MODIFIED: the reviewer tool-scope requirement, correcting the false premise and requiring the deny rules.
- `reviewer-finding-identity` — MODIFIED: the `code-reviewer` NOT-DO list.

## Impact

- **Changed:** the seven task-reviewer definitions; the three Kiro reviewer JSON files; `src/__tests__/reviewer-rule-parity.test.ts`.
- **Unchanged:** the proposal and aggregate-code reviewer prose on the six non-Kiro surfaces; every reviewer's `tools` array; the verdict set; the relevance budget; the stable-ID and ledger rules.

## Residual risk, stated rather than resolved

`permissions` is the CLI 3.0 form. Whether a Kiro 2.x installation tolerates the key or rejects the profile is **not documented**, and the configuration reference does not say how unrecognized keys are handled. Shipping the deprecated `toolsSettings` form alongside it was considered and rejected: it is deprecated precisely for shell rules, and relying on both keys being tolerated would depend on the same undocumented behaviour. If a 2.x installation is found to reject the profile, the fallback is to drop the key and return to prompt-only enforcement on that version — the prompt contract is unchanged and remains sufficient on its own.
