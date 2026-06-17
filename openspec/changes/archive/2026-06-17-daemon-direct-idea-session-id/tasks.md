# Tasks

## 1. Server: expose `directIdeaUuid`
- [x] 1.1 Add `directIdeaUuid: string | null` to `ResolveRootIdeaResult` and derive it as the first idea node on `lineage` in `src/services/lineage.service.ts` (no extra traversal).
- [x] 1.2 Confirm the route passes it through unchanged; add/extend tests in `src/services/__tests__/lineage.service.test.ts` and the route test for: direct≠root, direct==root (top-level), idea input, null cases, and unchanged existing fields.

## 2. Daemon: anchor + serialize on direct idea, deterministic id, disk-probe, remove map
- [x] 2.1 `cli/lineage.mjs`: parse and return `directIdeaUuid` from the same REST call (both ids; null on failure). [added `resolve()` returning both; `rootIdeaFor` kept as wrapper]
- [x] 2.2 `cli/waker.mjs`: `keyFor` → `idea:<directIdeaUuid>` (returns both ids); resolved `rootIdeaUuid` threaded into markQueued/wake and the execution snapshot — slice-from-key removed (BLOCKER fix).
- [x] 2.3 Spawn path: deterministic session id = directIdeaUuid; pre-validate lowercase UUID (visible log + no spawn on failure); decide new-vs-resume by probing `<config-dir>/projects/<cwd-escaped>/<id>.jsonl` (honor `CLAUDE_CONFIG_DIR`; platform-aware `escapeCwd`); cwd threaded waker→spawner for both probe and spawn.
- [x] 2.4 Remove `cli/session-map.mjs` (+ its test) and its wiring in `cli/daemon.mjs`; drop `~/.chorus/sessions.json` reads/writes.
- [x] 2.5 Tests in `cli/__tests__/`: keyFor uses direct idea; snapshot-reports-resolved-root (≠direct); disk-probe new-vs-resume; same-cwd probe+spawn; UUID pre-validation rejects + logs; per-entity fallback on null/failure; POSIX + Windows cwd escaping.

## 3. Integration checkpoint
- [x] 3.1 End-to-end: a notification resolves to a direct idea → daemon spawns `--session-id <idea-uuid>` → transcript lands at `<cwd-escaped>/<idea-uuid>.jsonl` → a second same-idea wake resumes it; a parent-idea notification spawns a distinct session. [daemon-integration.test.mjs — real daemon + real probe + spawn stub writing the transcript; asserts new→resume→isolation + id-addressable paths]
