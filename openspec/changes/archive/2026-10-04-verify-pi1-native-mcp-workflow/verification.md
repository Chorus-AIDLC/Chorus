# Pi 1.0.2 native MCP verification

User authorization: Idea comment `54859c03-029d-4739-b06e-75e915d4ed4f`. Follow-up task: `cc7fb98b-a9c8-4de3-a912-37eecc123de6`.

## Host and isolation

```json
{
  "piVersion": "1.0.2",
  "nodeVersion": "v24.21.0",
  "binary": "/home/ubuntu/.nvm/versions/node/v24.21.0/bin/pi",
  "sdkDir": "/home/ubuntu/.nvm/versions/node/v24.21.0/lib/node_modules/@earendil-works/pi-coding-agent",
  "adapterConfigured": false,
  "builtinMcpDisabled": false,
  "existingAuthFilePreserved": true,
  "providerAuthEntries": 0,
  "fixtureConfiguration": "Isolated mcp.json with local stdio Chorus fixture; exposure omitted for default codemode, direct explicitly selected; no persistent production MCP configuration changed."
}
```

`npm install -g @earendil-works/pi-coding-agent@1.0.2` completed. The original checkout remains on its untouched dependency tree; the isolated Pi package and native test use the installed 1.0.2 SDK. No auth credential values are copied or printed. The native fixture and bookkeeping server bind local resources, and native settings/session/model auth files live in disposable temporary directories. `PI_OFFLINE=1` and telemetry disabled apply to the child probes. No adapter or built-in MCP disabling entry was present on Bob's host, so none needed removal.

## Reproduce

```bash
cd packages/chorus-pi
node test/pi1-native-mcp.mjs
bash test/all.sh # requires bun
node scripts/validate-package.mjs
```

The SDK probe loads both actual packaged extensions (including the bundled subagent) and native MCP/codemode/tool-search via Pi's extension loader, binds a real session, discovers the local stdio server, and supplies deterministic assistant tool calls through a registered local provider. It never fabricates tool events or invokes Chorus handlers directly. QuickJS native codemode calls and the SDK tool pipeline perform execution and generate event/queue/transcript evidence. The fixture `chorus_add_comment` is a no-op; it does not post a production comment.

## Results

15 scenarios, 120 real MCP calls, 558 tool events, 18 corresponding reviewer steering messages. Each base scenario includes three workflow successes, three workflow failures, an extra-tail tool, a non-target with decoy `input.tool`, and a fixture comment call. Reviewer scenarios parse the three actual agent files, use parent-discovered MCP names with the same dispatcher expansion, and verify only query/comment tools remain callable. All cases pass. Each actual reviewer executes `chorus_get_task`, `chorus_list_tasks`, `chorus_list_projects` and the no-op `chorus_add_comment`; its callable native names are asserted to equal only these four fixture operations.

| Exposure | Gate or actual reviewer profile | MCP cases | Tool events | Steering messages | Result |
|---|---|---:|---:|---:|---|
| codemode | all | 9 | 54 | 3 | PASS |
| codemode | none | 9 | 54 | 0 | PASS |
| codemode | chorus-proposal-reviewer | 9 | 54 | 2 | PASS |
| codemode | chorus-task-reviewer | 9 | 54 | 2 | PASS |
| codemode | chorus-code-reviewer | 9 | 54 | 2 | PASS |
| codemode | unconfigured | 9 | 54 | 0 | PASS |
| direct | all | 9 | 27 | 3 | PASS |
| direct | none | 9 | 27 | 0 | PASS |
| direct | chorus-proposal-reviewer | 9 | 27 | 2 | PASS |
| direct | chorus-task-reviewer | 9 | 27 | 2 | PASS |
| direct | chorus-code-reviewer | 9 | 27 | 2 | PASS |
| direct | unconfigured | 9 | 27 | 0 | PASS |
| codemode | chorus-proposal-reviewer | 4 | 24 | 0 | PASS |
| codemode | chorus-task-reviewer | 4 | 24 | 0 | PASS |
| codemode | chorus-code-reviewer | 4 | 24 | 0 | PASS |

Representative default-codemode observations:

```json
[
  {
    "operation": "chorus_pm_submit_proposal",
    "toolName": "mcp__chorus__chorus_pm_submit_proposal",
    "parentToolCallId": "fixture-0",
    "reminderCount": 1,
    "steeringText": [
      [
        {
          "type": "text",
          "text": "spawn chorus-proposal-reviewer to review the proposal, wait for its VERDICT comment, then close the agent"
        }
      ]
    ]
  },
  {
    "operation": "chorus_submit_for_verify",
    "toolName": "mcp__chorus__chorus_submit_for_verify",
    "parentToolCallId": "fixture-1",
    "reminderCount": 1,
    "steeringText": [
      [
        {
          "type": "text",
          "text": "spawn chorus-task-reviewer to review the task, wait for its VERDICT comment, then close the agent"
        }
      ]
    ]
  },
  {
    "operation": "chorus_admin_verify_task",
    "toolName": "mcp__chorus__chorus_admin_verify_task",
    "parentToolCallId": "fixture-2",
    "reminderCount": 1,
    "steeringText": [
      [
        {
          "type": "text",
          "text": "if this was the last task of an idea-rooted proposal: spawn chorus-code-reviewer over the idea's aggregate change, wait for its VERDICT comment, then remind to archive the openspec change"
        }
      ]
    ]
  }
]
```

Each child has its own real `tool_call`/`tool_result` name and ID; codemode results and execution-end events add no second reminder. Failure cases explicitly verify a failed child under a successful parent script. Queue events show reminders in steering, never follow-up. Direct calls have no codemode parent. Individually disabled reviewers leave the other two enabled, and missing Chorus configuration suppresses all reminders.

Raw scenario output with every captured event and steering text is emitted by the command and retained for this run at `/tmp/chorus-pi-dsh-workflow/pi1-native-results.json`. The fixture does not validate production workflow schemas or alter real Chorus state. No provider-backed inference or complete production reviewer dispatch/VERDICT cycle was executed; this is actual SDK host-pipeline evidence, separate from the mocked offline suite.

## Compatibility changes and other checks

The operation matcher and gateway policy remain unchanged. Pi's nested-tool hard allowlist required adding codemode/tool_search and expanding only parent-discovered native Chorus query/checkin/comment names for bundled reviewers, while retaining legacy entries, project read-only restrictions and worker/custom-agent selection. Submission/admin mutations are excluded. The optional peer range is `>=1.0.0 <2.0.0`; its workspace resolution is 1.0.2. Lock regeneration and a frozen check succeeded in a separate clean workspace; every non-Pi importer remained byte-equivalent in parsed content.

Independent task review identified incidental shared snapshot updates: `make-dir@4.0.0` moves semver 7.7.3 → 7.8.5; `@typescript-eslint/typescript-estree@8.54.0(typescript@5.9.3)` and `is-bun-module@2.0.0` move semver 7.8.0 → 7.8.5. These resolutions are retained. The unchanged importer comparison does not assert unchanged transitive graphs.

Pi offline suite: 43 static checks; 117 helper, 75 event, and 8 agent tests pass; 1 existing optional skip. Package validation passes. Strict OpenSpec validation and git whitespace checks pass. dsh code and existing source checkout are unchanged.

## Corrected earlier finding

The claim that Pi 1.x native codemode hides internal operation names, or requires direct exposure, was incorrect. It applies to the old adapter's single proxy, not native Pi 1.0.2. These actual SDK results confirm Leo's account and the selected outer-only matcher. The pending native-MCP Proposal still owns broad installer/CLI migration; `chorus agents add` continues to install the legacy adapter until that separate work lands. No push, merge, or release has been performed.

## Aggregate-review blocker regression

Aggregate Round 3 reported `B3-reviewer-list-reads-excluded` (comment `2b4db326-c9af-4201-958b-c8952409a9d9`): the code reviewer needs `chorus_list_tasks`, but the initial expansion only admitted get/query/comment names. Follow-up task `0e032890-dec2-4b6d-8d57-8822428d4a70` adds only discovered `chorus_list_tasks` and `chorus_list_projects`, both public read operations; generic list prefixes and business/admin/submit operations stay excluded. Unit regressions check the actual prescribed tool bullets of all three reviewers, and the native SDK profile scenarios execute both list operations under the hard allowlist. These new executions account for the increase from 114/522 to 120/558 calls/events. Pi offline now passes 117 helper + 75 event + 8 agent tests (200 actual), with the same 43 static passes and 1 existing optional skip; the previous independent dsh 404/type/lint/package checks remain applicable to its unchanged code. Task and aggregate verdicts are recorded separately; passing these tests alone does not close B3.
