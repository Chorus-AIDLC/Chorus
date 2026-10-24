## Context

`ideaTeamEnrollment`, `teamState`, and `assertIdeaTeamGate` currently use Team lead membership and `teamLeadAgentUuid`. Assignment state is written by several paths: UI actions, REST claim/assign, MCP, human conversational creation/pinning, and confirmed project handoff. Notifications and daemon admission also use the stored lead. Changing just the enrollment predicate would leave stale authorization, wake routing, and confusing UI behavior.

The confirmed choices are authoritative over Clay's initial defaults: explicit human selection at creation DOES start; verified agent-mediated assignment DOES start; cross-owner private-Team activation needs receiver-owner consent; YOLO survives reassignment. At planning the live Team context reported `proposalGate=human`, so the proposal was held for authorization. Felix subsequently requested YOLO in comment `bbfb5d2d-ca4c-4904-83c8-e87c409bbb7a` (2026-10-24T08:12:28.995Z); after independent Round 2 PASS the proposal was approved under that explicit authorization, not by changing the mechanism under development.

## Goals / Non-Goals

Implement per-Idea ownership and auditable start consent without privilege escalation, duplicate execution, or destructive migration. Preserve deterministic recommendations, existing workflow stages, project isolation, and human management. Do not expand super-admin semantics, introduce independent reviewer routing, revoke per-Idea YOLO on reassignment, or automatically run completed historical work.

## Decisions

### 1. Enrollment and live responsibility

Retain existing physical fields for rolling compatibility; expose `orchestrator` as the canonical domain concept and keep `lead` DTO/action aliases temporarily. `teamLeadAgentUuid` stores the enrolled logical orchestrator, NOT eligibility through `roles.lead`. Add nullable start-authority metadata, a generation counter, and an explicit enrollment-version marker via a NEW migration. Existing rows remain legacy-version rows, with no invented consent timestamp or user. Newly authorized enrollment uses the new version.

New enrollment requires an active same-company human authority whose UUID equals the receiving agent's current owner, that agent's current project editor access and `idea:write`, and a bound private project Team. Neither Team membership nor the full Team lead permission bundle is required. Individual operations check their own permissions. Existing lead configuration remains intact as an optional default suggestion, never as an ownership override. Do not change stored template schemas for cosmetic reasons.

The live orchestrator must still match the Idea assignee, agent owner and enrolled Team owner; ownership transfer invalidates the context. Loss of basic eligibility or Team unbinding pauses without replacing the assignee. Missing only an operation's permission leaves enrollment intact and explains the human action needed.

### 2. Verified human assignment authority

Never accept a caller-supplied `assignedByType=user` as proof. Resolve authority from authenticated human requests or a server-validated, persisted source. Store actual executor and authorizing human separately.

Direct human UI/REST assignment and confirmed project handoff authorize atomically. Human-selected conversational creation must persist selection authority on the server and bind it to the exact created Idea and selected logical agent; no authority is inherited by derived child Ideas. Pure creation has no authority. Runtime-only instance pin changes neither authorize enrollment nor start work.

For agent-mediated assignment, extend MCP with an optional `humanAuthorizationUuid`. A tenant-scoped authorization record binds company, project, Idea, target logical agent, authorizing human, expected assignment generation, source, expiry, and consumed operation. It may be minted by an authenticated human confirmation control, or deterministically from a human comment on that Idea containing a standalone `chorus:assign <agent-uuid>` instruction. Normal prose and a mere @mention are not machine-verifiable consent: the agent must request the confirmation control or exact structured command instead of asserting intent. Keep this concrete supported syntax in agent-facing help and tool instructions, not in the normal Idea assignment UI or Team gate panel. D2 backend authorization remains unchanged; normal human assignment uses the existing modal and does not require a separate proof-generation step.

Only the source's real human author may authorize their own agent's Team. Server validation rechecks current human and agent project access, human assignment authority, agent ownership and Idea/project identity. Reject agent-authored, foreign-Idea, foreign-tenant, wrong-target, edited/deleted, expired or stale-generation sources. Expiry is 24 hours; prior assignment/release invalidates unused proof immediately. Source uniqueness and atomic consumption prevent replay. A retry of the identical committed operation returns the recorded outcome without another generation or wake. Invalid supplied proof rejects the operation; omitted proof preserves permitted legacy assignment behavior but does not activate new automation.

Conversation creation uses a server-generated selection record rather than parsing the user's prose. It binds once when the server creates the Idea, before delivering its creation turn. Replaying that creation request must not create duplicate enrollment or a second kickoff.

### 3. Atomic assignment, handoff and exit

Consolidate all effective assignment writes through a transaction-aware transition helper; test entry points that currently bypass `assignIdea`. Mutation, proof consumption, generation, delegate invalidation and activity commit together; publish only after commit, using existing bounded conflict retry. Invalid access must not partially update assignment.

New authorized assignment, including deliberate same-agent reassignment, increments generation, clears the previous product delegate and updates the orchestrator. A duplicate request does not. Publish one generation-keyed assignment kickoff even if the logical agent did not change, using existing instance/cwd rules. Offline ownership persists for durable delivery; instance repinning alone is not a kickoff. Continue from the current stage; a terminal/done Idea must not restart completed work automatically.

Human cross-owner assignment preserves legitimate assignee changes but clears active new enrollment; only the receiving agent's owner can confirm it by same-agent reassignment or proof. Human assignment to a user and release clear enrollment and invalidate prior generation. Agent-initiated reassignment without valid human proof cannot enroll or refresh an existing enrollment; if responsibility changes, retain a paused guard until a human repairs it. Such a call must not clear the managed guard as an approval bypass. An unauthorized same-agent repeat neither increments generation nor clears delegates.

### 4. Wake and mutation fencing

Capture Idea UUID and enrollment generation in directed orchestrator/product wake context. Validate recipient, current assignee/delegate, Team owner, active enrollment and generation both when scheduling and at admission, resume and recovery. The compatibility action name `team_lead_handoff` may remain, but its semantics and prompts reference the Idea orchestrator.

An A→B→A reassignment must reject generation-1 work even though the agent UUID matches again. Fence product handoff mentions as well as dedicated lifecycle notifications; an ordinary broadcast must not bypass a rejected directed turn. Ordinary unrelated comments retain their existing notification behavior. Already executing tasks are not killed, but later proposal/approval/verification mutations recheck current context. Product-authoring operations originating from a delegated turn carry and validate its delegation generation, preventing old work from regaining authority after re-delegation to the same agent.

Legacy managed rows retain pre-upgrade protection and existing lead qualification until an explicit authorized transition opts them into the new version. No migration emits wakes or reads `assignedAt` as consent. Legacy persisted turns remain subject to the legacy current-owner checks only while their Idea remains legacy; version/generation mismatches after a new enrollment are rejected. Old clients with insufficient fencing support must not admit new-version directed automation; surface a client-upgrade warning rather than allowing an unfenced fallback. Include the capability/compatibility path in maintained daemon ports and cross-port contract tests.

### 5. Gates and private recommendations

Coalesced notifications use one primary running admission and server-persisted `admissionTurnUuids`. Merged rows must not be presented as independently admitted supplementary proofs. Mutation checks resolve the canonical same-session bundle, require unchanged primary admission/connection and merged secondary rows, and validate every persisted source fence, including mixed ordinary/fenced batches. Independently admitted supplementary runs remain supported and each is validated in full.

Resume resolves and validates the interrupted primary's complete original bundle before creating a continuation, then persists the union of its original source fences in the continuation's wake context. Ordinary-first and repeated resumes retain all source authority; revoked secondary sources reject creation, delivery, admission and protected mutations rather than refreshing authority from current assignments.

All proposal submission/approval and task verification paths use live current-orchestrator context and retain lifecycle/required-AC checks inside retried transactions. Non-YOLO approval remains human. YOLO evidence remains human `yolo_requested` for the exact Idea, without new enrollment-time filtering. Reassignment transfers the current-agent role, NOT broader permissions. Multi-Idea/document ancestry must satisfy every source gate; differing orchestrators may require human approval.

Products keep existing delegated authoring permissions, not approval rights. Recommendations preserve online eligibility, reopen affinity, least-load/dependency tie-breaking and empty-role manual fallback; only offline-role fallback changes from fixed lead to eligible current orchestrator. Private roster/proof details are never returned to foreign owners or safe gate-only viewers.

### 6. UI and delivery

Use “Idea 负责人” for actual orchestration and “默认负责人（可选）” for Team lead suggestions. Normal human assignment stays in the existing assignment modal; selecting the assignee itself supplies human authorization subject to the unchanged server checks. Do not add a proof-generation button, display proof UUIDs, or show `chorus:assign` command hints in the normal Idea UI. This presentation cleanup does not remove D2 agent-mediated authorization, conversational creation selection, receiver-owner consent or any backend protections.

Hide the Team gate panel entirely for unmanaged Ideas, including unassigned and assigned-but-not-authorized Ideas; responsibility remains in the existing assignee field, never a misleading “no owner” explanation. For managed Ideas, render only two compact rows: proposal approval (human or current Idea orchestrator according to the server gate) and task verification (current Idea orchestrator according to the server gate). If paused, add only its privacy-safe reason. Respect server-reported human-action gates and safe gate-only responses without exposing private rosters or proof details. Do not add legacy notices, YOLO explanatory text, loading indicators or read-failure messages to this panel.

Read context silently on mount, on window focus and every 30 seconds while mounted. Successful refreshes replace displayed gate responsibility and paused state so external reassignment, Team unbinding and pause are reflected. A rejected request or unsuccessful response clears the displayed context and hides the panel instead of preserving stale approval responsibility or pause information; later successful reads may restore the appropriate managed panel. Remove focus listeners and timers on unmount and ignore late results after unmount. Refresh introduces no additional UI elements.

Update all maintained runtime/skill ports via the repository's existing maintenance policy, including CLI, OpenClaw and Hermes fencing and recovery. No package publication is implied. Deployment must verify that installed local clients can handle the new context before enabling new-version automation.

## Migration / Rollout

Take and validate a PostgreSQL backup, retain the current application image and deployment configuration. Apply only additive migrations; do not rewrite `20261023091000_idea_team_enrollment`. Default new metadata to legacy/no-authority and do not bulk enroll. Validate migration on a database containing current rows before touching the real stack. A code rollback after new-version enrollment is unsafe unless the old image understands the version marker: prefer forward repair; otherwise stop the stack and restore the matched pre-deploy database/image with explicit handling of post-backup writes. Do not advertise a blind image-only rollback as safe.

## Verification

DB-backed tests cover every assignment origin, proof replay/races and tenant isolation, conversational selection, two independent non-lead owners, same-agent kickoff dedup, A→B→A fences, re-delegation fences, cross-owner consent, legacy upgrade, terminal Ideas, Idea-scoped YOLO, per-action denials, and the retained S1 retry regressions. Browser tests verify the existing assignment modal, absence of proof UI, hidden unmanaged panels, compact managed gate rows and optional paused reason using isolated fixtures. Component tests cover silent focus/30-second refresh after external reassignment, unbinding and pause, hiding on rejected/unsuccessful reads, recovery on successful reads and unmount cleanup. Capture fresh browser evidence for the cleaned-up UI rather than reusing pre-cleanup screenshots. Run targeted tests, root suite/typecheck and maintained port tests; independently review aggregate changes before deployment. Record health, migration, MCP context, runtime compatibility, backup and image evidence after deploying the saved local stack without destroying volumes.
