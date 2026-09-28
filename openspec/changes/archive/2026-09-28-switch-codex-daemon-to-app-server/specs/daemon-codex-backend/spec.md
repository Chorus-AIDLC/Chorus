## REMOVED Requirements

### Requirement: Headless Codex wake over `codex exec --json`
**Reason**: Replaced by stdio App Server.
**Migration**: Preserve anchors and use thread/start or thread/resume, then turn/start.

### Requirement: Codex interrupt via detached process-group kill
**Reason**: App Server supports protocol cancellation before bounded tree cleanup.
**Migration**: Register a protocol stop hook and retain the shared process-tree fallback.

## MODIFIED Requirements

### Requirement: Codex session anchoring via a persisted idea→thread-id map

Because Codex generates its own `thread_id` rather than accepting a client-supplied session id, the daemon SHALL capture the generated `thread_id` from authoritative App Server setup responses or notifications and SHALL persist a mapping from the Chorus session anchor (the direct idea uuid, or the entity uuid for an ad-hoc session) to that `thread_id` in a daemon-local store. For a fresh run, the daemon SHALL persist the mapping immediately after the first valid generated thread identifier is observed, without waiting for the turn or process to exit successfully. Repeated identifier events within the same wake SHALL result in exactly one persistence call. On a subsequent wake for the same anchor, the daemon SHALL resume the existing Codex session via `thread/resume` with that thread id; when no mapping exists for the anchor, it SHALL start a fresh `thread/start` request. The new-vs-resume decision for the Codex backend SHALL be made from this map (not from the Claude on-disk transcript probe), and lifecycle logs SHALL NOT report a contradictory Claude-probe decision as the Codex command state. The persistence SHALL be best-effort: a read failure SHALL degrade to starting a fresh session with a visible log; a write failure SHALL keep the established thread for the current wake and log reduced future continuity, never throwing into the wake path.

#### Scenario: Same anchor resumes the same Codex thread

- **WHEN** a wake fires for an anchor whose `thread_id` was recorded by a prior Codex run
- **THEN** the daemon runs `thread/resume` with that thread id so the conversation continues, rather than starting a new session

#### Scenario: First wake for an anchor starts fresh and records the thread id

- **WHEN** a wake fires for an anchor with no recorded `thread_id`
- **THEN** the daemon starts a new `thread/start` request, captures the first valid generated `thread_id` from the setup response or notification, and immediately persists the anchor-to-thread-id mapping for future resumes

#### Scenario: Interrupted first turn remains resumable

- **WHEN** a fresh Codex wake emits a valid `thread_id` and is then interrupted before a successful process exit
- **THEN** the mapping MUST already contain that `thread_id`
- **AND** the next wake for the same anchor MUST invoke `thread/resume` with that thread id instead of starting a fresh thread

#### Scenario: Failure before thread establishment does not create a mapping

- **WHEN** a fresh Codex process fails or exits before emitting a valid generated thread identifier
- **THEN** the daemon MUST NOT persist an inferred, blank, or anchor-derived thread identifier

#### Scenario: Duplicate identifier events are idempotent

- **WHEN** a fresh Codex wake emits the same valid generated thread identifier more than once
- **THEN** the daemon MUST invoke mapping persistence exactly once for that wake
- **AND** the persisted mapping MUST equal the emitted identifier

#### Scenario: Codex lifecycle state reflects the map-based decision

- **WHEN** the Claude transcript probe and the Codex thread map would produce different new-vs-resume answers
- **THEN** the Codex command MUST follow the thread map
- **AND** daemon lifecycle logs MUST NOT claim that the contradictory Claude-probe answer was used

#### Scenario: Existing exec history is resumed after upgrade
- **WHEN** an existing anchor points to a thread created by the old exec backend and the installed App Server can restore it
- **THEN** the daemon MUST resume that thread without changing its anchor or losing the existing context

#### Scenario: Definitively unavailable history falls back once
- **WHEN** thread/resume returns a verified definitive unavailable-history error
- **THEN** the daemon MUST try thread/start at most once using the existing Chorus wake context, persist the new authoritative ID before the turn, and emit one visible transcript continuity notice and log
- **AND** the wake result MUST identify the new backend session and isNew=true

#### Scenario: Uncertain resume failure preserves history
- **WHEN** resume times out, the transport closes, or authentication/configuration fails
- **THEN** the wake MUST fail visibly without starting another thread or replacing the stored mapping

#### Scenario: Fresh fallback also fails
- **WHEN** definitive history failure is followed by a failed thread/start
- **THEN** the daemon MUST preserve the old map entry and settle the wake as failed without another fallback


### Requirement: Permission mode maps to a Codex sandbox posture, defaulting to YOLO
The daemon SHALL map its resolved permission mode to App Server configuration on both thread/start and thread/resume and relevant turn overrides: yolo SHALL use the supported full-access sandbox posture and noninteractive approval policy; chorus SHALL use the supported read-only sandbox posture and noninteractive approval policy. An unconfigured daemon SHALL retain its existing yolo default. The implementation MUST verify exact field names against the supported CLI schema and MUST NOT let stored thread policy or custom args override the daemon's resolved posture. Read-only refers to Codex sandbox semantics, including read-only commands permitted by that sandbox. MCP availability also depends on operator-configured per-tool approval rules; read-only sandbox posture alone SHALL NOT be documented as guaranteeing every Chorus MCP tool is permitted. The daemon MUST NOT broaden sandbox access or automatically grant native approval requests to make a tool succeed.

#### Scenario: Default codex wake runs with full-autonomy sandbox bypass
- **WHEN** the daemon wakes codex without a permission override
- **THEN** App Server MUST receive the resolved yolo posture without an interactive approval requirement

#### Scenario: Restricted posture runs codex read-only
- **WHEN** the daemon wakes codex in chorus posture
- **THEN** App Server MUST receive the read-only sandbox with noninteractive approvals and MUST NOT be granted write/full-access permissions by the adapter

#### Scenario: Resume honors current posture
- **WHEN** a persisted thread has a different historical permission policy
- **THEN** the resumed wake MUST apply the daemon's current resolved posture


## ADDED Requirements

### Requirement: Codex wakes use a bounded stdio App Server lifecycle
The codex daemon backend SHALL exclusively spawn codex app-server --listen stdio://, resolve its executable/shim through existing platform rules and CHORUS_CODEX_PATH, pass the wake prompt only through stdin RPC, and preserve CHORUS_DAEMON_HEADLESS=1 and existing agent configuration/environment isolation. It MUST complete initialize/initialized before thread setup and turn/start, keep stdin open during execution, and settle exactly once after terminal outcome and bounded cleanup. It SHALL use Node built-ins/existing dependencies. It SHALL NOT select exec as a fallback, open a remote listener, or reuse a child across wakes.

#### Scenario: New wake follows protocol ordering
- **WHEN** a new Codex wake starts
- **THEN** the daemon MUST initialize its stdio connection, establish a thread, submit one turn and parse correlated notifications; prompts and credentials MUST NOT enter argv/logs

#### Scenario: Missing binary or incompatible CLI
- **WHEN** the executable is absent or required App Server protocol/options are unsupported
- **THEN** the daemon MUST emit an actionable error, settle failure without crashing, and MUST NOT launch exec

#### Scenario: Process exits zero before successful terminal event
- **WHEN** the child exits zero without a matching completed-success turn
- **THEN** the wake MUST fail rather than falsely report success

#### Scenario: Terminal state and process state disagree
- **WHEN** the turn fails or is interrupted even though the child later exits zero
- **THEN** the wake MUST retain the failed/interrupted outcome

#### Scenario: RPC response deadline or protocol fault
- **WHEN** handshake, thread setup or turn submission reaches its finite response limit, or protocol input is malformed/oversized, or IO fails
- **THEN** pending RPCs MUST be rejected, the wake MUST fail visibly and perform bounded cleanup without repeating turn/start

#### Scenario: Unrelated notifications and duplicate terminal events
- **WHEN** notifications target another thread/turn or repeat a terminal event
- **THEN** they MUST NOT complete or duplicate this wake's transcript, usage or terminal reporting

#### Scenario: Silent long-running turn
- **WHEN** a submitted turn is still running, including while a command emits no output or notifications
- **THEN** it MUST remain running without an inactivity watchdog or total-duration cutoff until terminal outcome, process/transport failure, or authorized cancellation

#### Scenario: Interrupt a silent turn
- **WHEN** the user interrupts a running turn that has emitted no recent progress
- **THEN** the daemon MUST still send turn/interrupt when its ID is known and retain bounded cancellation cleanup

### Requirement: Native human requests never block a headless Codex wake
Known native approval/input requests SHALL receive a supported negative/cancel response with a visible diagnostic. If no safe schema-valid response exists, the adapter SHALL interrupt/fail and clean up. Unknown server requests SHALL receive a method-not-supported response and MUST NOT create unbounded waiting. Human decisions SHALL continue through existing Chorus comments/elaboration, with no new bridge UI and no auto-approval.

#### Scenario: Native approval is requested
- **WHEN** App Server requests command/file/permission approval
- **THEN** the daemon MUST deny/cancel through the supported protocol or terminate with a diagnostic, never approve solely because the session is headless

#### Scenario: Native user input is requested
- **WHEN** App Server asks for interactive input
- **THEN** the daemon MUST respond with a supported cancellation or fail/clean up visibly without terminal input or invented human answers

### Requirement: App Server assistant text preserves existing transcript delivery
The adapter SHALL emit completed assistant-message snapshots as the existing internal item.completed/agent_message envelopes, preserving distinct commentary/final item identities and suppressing duplicate snapshots and deltas. It SHALL filter by the selected thread and current turn and SHALL keep tool/reasoning/request payloads out of the conversation transcript. Existing upload and terminal reporting contracts SHALL remain unchanged.

#### Scenario: Message arrives as deltas and a completed snapshot
- **WHEN** one assistant item produces several text deltas followed by its full completed snapshot
- **THEN** the conversation MUST receive exactly one copy of the completed text for that item

#### Scenario: Commentary and final answer are separate items
- **WHEN** a turn contains a commentary item and a final-answer item
- **THEN** both MUST be delivered once with their separate identities, while unrelated thread events MUST be ignored

### Requirement: Codex cancellation uses protocol then bounded process-tree cleanup
The spawner SHALL register a protocol-stop capability before exposing its child to the daemon. A stop SHALL latch during initialization and prevent subsequent turn submission; for an active turn it SHALL request turn/interrupt and wait only within the shared graceful deadline before tree escalation. Normal completion SHALL close stdin and clean up without creating a user interrupt. Session mappings SHALL survive cancellation once a real thread ID is captured.

#### Scenario: Running turn is interrupted
- **WHEN** an authorized interrupt targets an active Codex turn
- **THEN** the daemon MUST request turn/interrupt and clean up its process tree, preserving user-interrupt reporting and the recorded thread ID

#### Scenario: Interrupt occurs during startup
- **WHEN** cancellation arrives after child spawn but before a turn is active
- **THEN** startup MUST stop and MUST NOT submit a later turn/start

#### Scenario: First turn interrupted after thread setup
- **WHEN** the first wake is interrupted after its thread ID is recorded
- **THEN** the next wake MUST resume that ID rather than create a new thread

#### Scenario: Descendant retains output pipes
- **WHEN** the leader exits but a descendant retains pipes or remains running
- **THEN** the wake MUST use bounded exit draining and tree cleanup rather than wait indefinitely for close
