## MODIFIED Requirements

### Requirement: Explicit owner enrollment and durable pause
The system SHALL support new-version Team enrollment for each Idea's logical agent assignee following verified human assignment authority, without requiring membership in the Team lead role. It SHALL preserve legacy protections and current lifecycle state.

#### Scenario: Creation without owner
- **WHEN** an Idea is created without human selection of an assignee
- **THEN** it remains unassigned and no Team agent is automatically claimed or woken

#### Scenario: Human-selected conversational creation
- **WHEN** a human explicitly selects their eligible agent while creating an Idea
- **THEN** the server binds that selection to the created Idea, enrolls its assignee and starts once without requiring another assignment

#### Scenario: Independent non-lead owners
- **WHEN** a human assigns two Ideas to two eligible agents outside the Team lead role
- **THEN** each Idea has its own active orchestrator and neither is taken over by the Team default lead

#### Scenario: Eligible lead assignment
- **WHEN** a human explicitly assigns their eligible agent who also appears in the optional Team lead role
- **THEN** it enrolls under the same per-Idea authority rules as a non-lead agent, preserving current stage and the assignment kickoff

#### Scenario: Same-agent explicit restart
- **WHEN** a human deliberately reassigns an existing nonterminal Idea to the same eligible agent
- **THEN** generation advances, old delegation is invalidated, and one kickoff resumes the current stage
- **AND** retrying that same operation produces no duplicate generation or wake

#### Scenario: Reassignment and release
- **WHEN** a human authorizes another eligible own agent
- **THEN** the new assignee becomes orchestrator and stale generations lose authority without killing running tasks
- **WHEN** the human assigns a user, assigns another owner's agent without their consent, or releases the Idea
- **THEN** active enrollment is removed and existing legitimate assignment behavior remains

#### Scenario: Untrusted reassignment
- **WHEN** an agent reassigns without valid human start authority
- **THEN** it cannot create or refresh enrollment, and changing an enrolled assignee retains a paused guard rather than bypassing managed gates

#### Scenario: Lead removal or unbinding
- **WHEN** an enrolled orchestrator loses owner consistency, project editor access, idea:write or its private Team binding
- **THEN** automation pauses, agent gates fail closed, and human repair is available without silently assigning someone else
- **AND** removal only from the optional Team lead role does not invalidate new-version enrollment

#### Scenario: Legacy migration
- **WHEN** the incremental deployment encounters existing unregistered or legacy registered Ideas
- **THEN** it emits no kickoff, does not invent human consent, preserves legacy guards and requires explicit authorization to enter the new version

### Requirement: Delegated product collaboration
The system SHALL let the current active Idea orchestrator explicitly delegate eligible product work without replacing the Idea assignee, while enforcing current permissions and delegation generation.

#### Scenario: Product handoff
- **WHEN** the orchestrator delegates an eligible product member
- **THEN** a generation-bound directed instruction permits that member to elaborate and author/submit proposals without claiming the Idea

#### Scenario: Ineligible or unrelated delegate
- **WHEN** responsibility changes, delegation changes, or a delegate loses eligibility
- **THEN** stale delegated turns and their later authoring mutations are denied, including after the same agent is delegated again

### Requirement: Private deterministic recommendations
Recommendations SHALL remain owner-private, permission-scoped and explain their selection or lack of selection, using the current Idea orchestrator instead of the fixed Team lead.

#### Scenario: Reopen affinity
- **WHEN** a reopened task's original developer is online and eligible
- **THEN** that developer is preferred over other online developers regardless of load

#### Scenario: Load and dependency tie
- **WHEN** other development tasks have multiple eligible online candidates
- **THEN** minimum activeCount wins, dependency affinity breaks only load ties, and remaining ties go to the current orchestrator

#### Scenario: Empty versus offline
- **WHEN** a role is empty or wholly ineligible
- **THEN** the result is manual rather than substituting an orchestrator
- **WHEN** eligible members exist but all are offline
- **THEN** an eligible online current orchestrator may be recommended, otherwise human handling is explicit

#### Scenario: Foreign context
- **WHEN** another owner's actor requests private routing or an unrelated task
- **THEN** no private roster or assignment proof is disclosed and the request is denied

### Requirement: Server-enforced per-Idea approval gates
All approval and task completion mutation paths SHALL enforce current enrolled orchestrator identity, existing action permissions and workflow preconditions inside each transactional attempt. Agent proposal approval additionally SHALL require human Idea-scoped YOLO; task verification SHALL NOT require YOLO.

#### Scenario: Non-YOLO approval
- **WHEN** an agent attempts approval of a non-YOLO enrolled Idea's proposal
- **THEN** the server rejects it even with proposal:admin and identifies the human gate

#### Scenario: YOLO follows the Idea
- **WHEN** an Idea with prior human YOLO authority is reassigned with valid start authority
- **THEN** the new current orchestrator may approve with proposal:admin without a new YOLO request, while the former orchestrator may not

#### Scenario: YOLO lead and task verify
- **WHEN** the current active orchestrator verifies a task
- **THEN** task:admin, current task state and required acceptance criteria must all pass
- **AND** verification is permitted for a non-YOLO Idea when those checks pass
- **WHEN** only an action permission is missing
- **THEN** that action is denied with a human-action explanation, without granting privileges or invalidating otherwise eligible enrollment

#### Scenario: Human and legacy compatibility
- **WHEN** an authorized human manages work or unmanaged/legacy-version work follows its existing rules
- **THEN** existing human management, project access and legacy guards remain enforced

#### Scenario: Multiple and document inputs
- **WHEN** a proposal derives from multiple Ideas or source documents
- **THEN** every reachable source gate applies with cycle protection and no ancestry bypass

#### Scenario: Coalesced notifications retain every source gate
- **WHEN** fenced notifications coalesce with each other or ordinary notifications into one admitted run
- **THEN** the client supplies only the primary admission proof and the server validates every source fence in its persisted same-session bundle
- **AND** merged members are not independent supplementary admissions, and secondary revocation or admission/connection replacement rejects protected mutations
- **AND** interruption and repeated resume preserve all original source fences durably; revoked secondary sources reject resume without a continuation or control dispatch, and post-creation revocation rejects delivery/admission

### Requirement: Consistent lead routing and visible gates
Lifecycle notifications, UI and maintained daemon/plugin ports SHALL consistently identify the Idea orchestrator, preserve generation fencing, and expose only privacy-safe gate information. Existing lead-named compatibility contracts SHALL NOT restore fixed-Team-lead authority. The normal assignment UI SHALL use the existing modal without proof controls or protocol hints; the Team gate panel SHALL be hidden for unmanaged Ideas and limited to compact server-reported proposal/task gates plus an optional paused reason for managed Ideas. Context refresh SHALL be silent on window focus and every 30 seconds, and failed reads SHALL hide the panel rather than preserve stale gates. These UI constraints SHALL NOT change D2 backend authorization or other confirmed assignment and gate semantics.

#### Scenario: Product proposal and task lifecycle
- **WHEN** proposals or linked tasks change lifecycle state
- **THEN** the current orchestrator receives a deduplicated generation-bound handoff, without independent reviewer automation

#### Scenario: Stale admission and recovery
- **WHEN** queued orchestrator or product turns are admitted, resumed or recovered after A-to-B-to-A reassignment
- **THEN** recipient, current responsibility, owner, active state and generation must match; old broadcasts cannot bypass a rejected turn

#### Scenario: Client compatibility
- **WHEN** a client cannot enforce new-generation turn admission
- **THEN** new-version directed automation is withheld with an upgrade warning rather than delivered through an unfenced fallback

#### Scenario: Gate display and port parity
- **WHEN** users view an Idea or agents receive its context
- **THEN** UI and all maintained skills distinguish Idea responsibility from optional Team default recommendations without leaking private rosters
- **AND** agent-facing context and instructions retain inactive/paused/human-action semantics while the UI uses only the compact gate presentation

#### Scenario: Normal human assignment uses the existing modal
- **WHEN** a human assigns an Idea through the existing assignment modal
- **THEN** that selection supplies human authorization subject to the unchanged server access, eligibility and receiver-owner consent checks
- **AND** the normal Idea UI has no extra proof-generation button, proof UUID or `chorus:assign` command hint
- **AND** D2 verified agent-mediated assignment and human-selected conversational creation remain supported by the unchanged backend authorization rules

#### Scenario: Unmanaged panel stays hidden
- **WHEN** an Idea is unmanaged, whether unassigned or assigned without Team enrollment
- **THEN** the Team gate panel is not rendered and the existing assignee field continues to show responsibility
- **AND** no manual-flow, missing-owner, legacy or authorization explanation replaces it

#### Scenario: Compact managed gates and paused reason
- **WHEN** an Idea is managed
- **THEN** the panel shows only compact proposal approval and task verification rows reflecting the server's gate responsibility, including any human-action fallback
- **AND** proposal approval identifies human or current Idea orchestrator responsibility and task verification identifies current Idea orchestrator responsibility when permitted by the server gate
- **AND** a paused Idea adds only its privacy-safe paused reason, without proof details, legacy notices, YOLO explanations, loading indicators or read-failure messages

#### Scenario: Silent refresh updates external changes
- **WHEN** the mounted panel reads context initially, on window focus or every 30 seconds
- **THEN** successful reads silently update gates and paused reasons after external reassignment, Team unbinding or pause, or hide the panel if the Idea becomes unmanaged
- **AND** refresh adds no visible controls or status messages

#### Scenario: Failed reads hide stale gates and may recover
- **WHEN** a context request rejects or returns an unsuccessful response
- **THEN** the panel clears its displayed context and hides rather than retaining stale approval responsibility or paused state
- **AND** a later successful read may restore the appropriate compact managed panel without an error or loading notice

#### Scenario: Refresh cleanup on unmount
- **WHEN** the panel unmounts
- **THEN** its focus listener and 30-second timer are removed, no further refresh requests are triggered and late results do not update the unmounted panel

## ADDED Requirements

### Requirement: Verifiable human start authority
New-version automatic progression SHALL require server-verifiable consent from the receiving agent's owner, bound to company, project, Idea, target agent and current assignment generation. Authority SHALL NOT be inferred from agent-authored assertions.

#### Scenario: Agent-mediated authorized assignment
- **WHEN** an agent supplies an unexpired, unused matching human authorization for assignment
- **THEN** the server validates its real human source and current permissions, consumes it atomically, enrolls the Idea and publishes one kickoff

#### Scenario: Structured instruction or human confirmation
- **WHEN** a human confirms a bound assignment or posts the documented standalone assignment command on that Idea
- **THEN** the server may mint matching assignment proof after validating source authorship, owner consent and current access
- **AND** arbitrary prose or a mere mention is not accepted as a machine-verifiable grant

#### Scenario: Invalid or replayed proof
- **WHEN** proof is agent-authored, changed/deleted, expired, wrong-target, foreign-tenant, foreign-Idea, stale-generation or replayed as another operation
- **THEN** assignment/enrollment are rejected without partial mutation or wake

#### Scenario: Cross-owner consent
- **WHEN** a legitimate assignment targets another user's agent without the receiving owner's consent
- **THEN** the assignment may persist but that private Team does not activate until its owner confirms

#### Scenario: No implicit activation
- **WHEN** an agent self-claims, repins a runtime, comes online, binds a template, or upgrades the server without new human assignment authority
- **THEN** it does not activate new-version Team orchestration or restart completed Ideas
