## Context

The eight maintained surfaces have intentionally independent host adaptations. Pi develop and all proposal skills contain the reference semantics. Hermes yolo's existing reviewer-marker `kind` text is unrelated to task-draft metadata and does not satisfy parity. Repository inspection confirms standalone `public/skill` has only proposal/yolo authoring paths, not separate openspec-aware/spec-lite skills; cover those existing paths rather than inventing new standalone capabilities.

## Goals / Non-Goals

Provide consistent guidance without flattening native host differences. Do not change server compatibility, introduce a shared runtime generator, port Pi's optional submit gate, or select/release a version.

## Decisions

1. Completion reports omit `status`; `chorus_submit_for_verify` owns `in_progress -> to_verify`. Recovery is conditional on confirmed premature transition, performed by the assignee with normal dependency checks, then developer self-check is repeated because developer/admin acceptance marks and evidence were cleared. Legitimately submitted tasks stay awaiting verification.
2. Every task-draft authoring skill includes a real add example with `kind` and documents `implementation`, `verification`, `docs`, `other`. Add/update paths preserve existing kind when omitted on update; kind is draft-only metadata, not a materialized Task field. Do not add kind to quick-task APIs.
3. E-DEP-UNKNOWN requires same-proposal returned draft UUIDs; E-DEP-SELF removes self edges; E-DEP-CYCLE removes/reorders cyclic dependencies. Validate again before submission. I-KIND and W-IMPL remain advisory. Reviewers block missing implementation only when required by actual scope; justified docs-only/verification-only proposals are valid.
4. Use targeted common Markdown semantics in each existing host copy. Develop/quick-dev and authoring/reviewer patches are separate write sets; yolo completion loops belong to the authoring patch to avoid overlap.
5. Add an existing-framework static test covering an explicit eight-surface matrix, extracted tool-call examples, recovery guidance and reviewer policy. Test detection with negative fixtures/mutations so token-only presence is insufficient. Run Pi static, Claude syntax, Hermes skill and other relevant package checks without fixing unrelated failures.
6. Human-selected release deferral overrides the normal immediate-bump checklist. Follow-up Idea `3abac691-a5aa-40ba-9fb5-523d29b434f3` tracks version choice, all affected manifests/frontmatter/client identifiers, release checks and coordinated publication; no publication occurs here.

## Risks / Trade-offs

- Broad text searches can confuse review filters or explanatory negative examples with invalid calls: scope tests to call blocks and explicit semantic checks.
- Generic kind text can accidentally match Hermes reviewer markers: require task-draft examples.
- Host-native tooling must remain intact; run host validators and inspect diffs.
- The current checkout contains unrelated work; do not change it or include it in review evidence.

## Implementation / Verification

Three tasks: (1) develop/quick-dev parity, (2) authoring and reviewer parity including yolo completion loops, (3) cross-host regression tests and integrated validation after both patches. Independent reviewers verify each task and aggregate change. OpenSpec artifacts are mirrored from file bytes and archived after verification.
