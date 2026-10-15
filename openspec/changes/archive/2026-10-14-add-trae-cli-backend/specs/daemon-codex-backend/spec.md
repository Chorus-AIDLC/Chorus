## MODIFIED Requirements

### Requirement: Permission mode maps to a Codex sandbox posture, defaulting to YOLO
The daemon SHALL map its resolved permission mode to App Server configuration on both thread/start and thread/resume and relevant turn overrides: yolo SHALL use the supported full-access sandbox posture and noninteractive approval policy; chorus SHALL use the supported read-only sandbox posture and noninteractive approval policy. An unconfigured daemon SHALL retain its existing yolo default. The implementation MUST verify exact field names against the supported CLI schema and MUST NOT let stored thread policy or custom args override the daemon's resolved posture. Read-only refers to Codex sandbox semantics, including read-only commands permitted by that sandbox. MCP availability also depends on operator-configured per-tool approval rules; read-only sandbox posture alone SHALL NOT be documented as guaranteeing every Chorus MCP tool is permitted. The daemon MUST NOT broaden sandbox access or automatically grant native approval requests to make a tool succeed, with exactly one exception: in chorus posture, when the user's Codex config declares a `[mcp_servers.chorus]` table, the daemon SHALL pre-approve the tools of that one Chorus MCP server for the woken thread by sending the per-thread `config` override `{"mcp_servers.chorus.default_tools_approval_mode": "approve"}` on thread/start and on thread/resume (including the history-unavailable fallback thread/start). This override is the only pre-approval the daemon makes. The daemon MUST NOT pre-approve any other MCP server, MUST NOT answer or pre-grant shell, file-change, permission or any other native approval request, MUST NOT change the sandbox or approval policy because of it, and MUST NOT write it to the user's config file. The daemon SHALL omit the override in yolo posture and whenever the config does not declare `[mcp_servers.chorus]` (an override under an undeclared server makes thread/start fail with "invalid transport"). The config SHALL be re-checked on every chorus-posture wake.

#### Scenario: Default codex wake runs with full-autonomy sandbox bypass
- **WHEN** the daemon wakes codex without a permission override
- **THEN** App Server MUST receive the resolved yolo posture without an interactive approval requirement

#### Scenario: Restricted posture runs codex read-only
- **WHEN** the daemon wakes codex in chorus posture
- **THEN** App Server MUST receive the read-only sandbox with noninteractive approvals and MUST NOT be granted write/full-access permissions by the adapter

#### Scenario: Resume honors current posture
- **WHEN** a persisted thread has a different historical permission policy
- **THEN** the resumed wake MUST apply the daemon's current resolved posture

#### Scenario: Chorus-only wake can call Chorus MCP tools but cannot write
- **WHEN** the daemon wakes codex in chorus posture and the user's Codex config declares `[mcp_servers.chorus]`
- **THEN** thread/start or thread/resume MUST carry `config: {"mcp_servers.chorus.default_tools_approval_mode": "approve"}` together with the read-only sandbox and approval policy `never`
- **AND** Chorus MCP tool calls in that thread MUST succeed while file writes stay blocked by the read-only sandbox

#### Scenario: Other MCP servers and native approvals stay refused
- **WHEN** a chorus-posture thread calls a tool of an MCP server other than `chorus`, or runs a command or file change that needs approval
- **THEN** the daemon MUST NOT have pre-approved it and the call MUST stay refused under approval policy `never`

#### Scenario: No pre-approval without a declared Chorus MCP server or in yolo
- **WHEN** the user's Codex config has no `[mcp_servers.chorus]` table, or the daemon runs in yolo posture
- **THEN** thread/start and thread/resume MUST NOT carry the `config` override
