# Chorus linkage

- Idea: `fa4fb713-e37c-43a7-ae5d-825842a5cb02`
- Project: `db88309c-6397-4b0c-b7db-0f947add2b2b`
- Proposal: `712f8c85-6ace-4f08-bb19-7b42d120c2c5`
- User decision: elaboration round 2, `253992d4-42b2-4378-bc97-5f524a8ec85c`

The round-2 custom answer explicitly selects the Checkbox and a **standalone research skill called by Idea or Proposal**. Earlier comments recommending inline-only / Idea-only research are superseded.

| Local source | Chorus document draft |
| --- | --- |
| proposal.md | `32313cf4-5c8f-4924-9a6c-195aa5b49527` |
| design.md | `32948a18-9750-4660-a316-828a2bb3ba8b` |
| specs/lightweight-research/spec.md | `20cb1817-0b50-42c7-b03d-b497b729d982` |
| specs/conversational-idea-entry/spec.md | `26d18228-d6cc-4b49-a43d-bf766e19eb1e` |

| Workstream | Task draft | Dependencies |
| --- | --- | --- |
| Shared skill and seven distributions | `1dd5ffc2-0692-4078-b5d9-a0931662d564` | none |
| Server request and instructions | `144e94a6-a543-4a13-9e08-fe46d7f6c77d` | none |
| UI and integration acceptance | `c2d8995b-f227-47d5-85e3-6d32fb3d17e9` | both above |

Document content is mirrored from local files via `chorus mcp call --arg-file content=...`. Task checkboxes are a local execution aid; Chorus tasks are the lifecycle authority. Fetch current Proposal state before resuming.

## Approved entities (2026-09-26)

Independent review round 2 passed (`db241bf8-a040-4bd9-912d-a193fd2766dd`). Proposal approved; execution resumed by the human YOLO request.

| Local source | Materialized document |
| --- | --- |
| proposal.md | `bc3eff2a-6d19-448c-8843-7d39abd4a7cc` |
| design.md | `f7782db2-cc54-4aa4-b9a9-ec383acf47db` |
| specs/lightweight-research/spec.md | `21b81a86-4012-4121-838c-fafdff344b30` |
| specs/conversational-idea-entry/spec.md | `45ffb14b-2c5d-476c-97f7-c544ad2265be` |

| Workstream | Materialized task |
| --- | --- |
| Shared skill and seven distributions | `2edee409-b153-4034-ad74-68ee3069b050` |
| Server request and instructions | `bae5871d-13c0-4b83-8ae7-64bec9286fbd` |
| UI and integration acceptance | `7c8b21c8-83f0-4950-83dd-0f165cdee8fb` |

## User-authorized scope amendment

User comment `b73abf2d-1684-49d2-8684-dbee456e6670` (2026-09-26 10:10) adds a Research action in the Idea Tracker before actual development begins. This supersedes earlier exclusion of the action-menu entry. The comment was delivered to this root session after approval.

- Additional task: `2b4ea9e5-96ec-453e-babb-425ad904388b` (depends on shared skill and server tasks; creation UI is independent).
- PRD, design and lightweight-research spec were updated locally and mirrored to their **materialized Documents**, verified byte-exact.
- Approved proposal draft snapshots retain the originally reviewed content; resume from current Documents and this local change, and include task 4.
- The prior reviewer PASS applies to the original scope; this explicit user-requested amendment has not undergone a separate independent proposal review.

Execution DAG refinement: task 4 does not consume the creation-dialog Checkbox; both UI surfaces consume tasks 1 and 2. Removed its unnecessary dependency on task 3 so design-tool availability cannot block independent implementation. Required design.pen acceptance remains unchanged.

2026-09-26 user amendment: comment25a4d74c-3e9f-4aaf-a019-75344cc77a50 explicitly waives Pencil synchronization and authorizes opening a PR and script deployment. Current task AC and specs retain all functional/browser checks.
