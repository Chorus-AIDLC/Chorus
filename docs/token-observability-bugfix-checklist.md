# Token Observability — Bug Fix Checklist

## Root Cause: Claude API usage fields have mixed semantics

Claude API transcript `message.usage` per turn:
- `input_tokens` — per-turn (incremental)
- `output_tokens` — per-turn (incremental)
- `cache_creation_input_tokens` — per-turn (incremental)
- `cache_read_input_tokens` — **cumulative** across the session

CC calculates `total_tokens = input + output + cache_create + cache_read` from the **last turn only**, because cache_read in the last turn already contains the full session total.

The old code sent ALL turns and summed them → cache_read was double-counted N times (once per turn). Front-end only showed `input + output`, hiding the real magnitude.

## Bug #1: Entity attribution — carry-forward wrong for sub-agents

**Symptom**: Reviewer tokens attributed to elaboration (idea entity) instead of review (proposal entity).

**Root cause**: carry-forward picks the last timeline entry before each turn. Reviewer reads idea for context before touching proposal → early turns attributed to idea. For sub-agents, ALL tokens belong to one primary entity regardless of which other entities they read.

**Fix**: `findPrimaryEntity()` picks highest-priority entity from timeline (task > proposal > idea > document). Sub-agent turns all go to that entity. Main agent still uses carry-forward.

- [x] `src/services/observability.service.ts` — replace sentinel with primary entity model
- [x] `src/services/__tests__/token-attribution.test.ts` — 16 tests covering both models
- [x] Verify: `pnpm test` — all pass

## Bug #2: Shell scripts send all turns → cumulative cache_read over-counted

**Symptom**: Token totals are 10-50x higher than CC reports.

**Root cause**: All three shell scripts (`on-stop.sh`, `on-subagent-stop.sh`, `on-session-end.sh`) extracted every assistant turn's usage and sent them as separate records. Server summed all records. Since `cache_read_input_tokens` is cumulative, summing N turns counts the same cache tokens N times.

**Fix**: Extract only the **last assistant turn** (which contains session totals). Also switch to temp files + `--slurpfile` + `curl -d @file` in all scripts.

- [x] `public/chorus-plugin/bin/on-stop.sh` — last turn only
- [x] `public/chorus-plugin/bin/on-subagent-stop.sh` — last turn + temp files + sourceSessionId
- [x] `public/chorus-plugin/bin/on-session-end.sh` — last turn + temp files + sourceSessionId
- [x] Verify: `bash public/chorus-plugin/bin/test-syntax.sh` — all pass

## Bug #3: Frontend tokensSum missing cache fields

**Symptom**: Page shows ~1.9k when CC reports ~23k.

**Root cause**: `tokensSum()` only summed `input_tokens + output_tokens`, missing `cache_creation_input_tokens` and `cache_read_input_tokens`. CC's formula includes all 4 fields.

**Fix**: `tokensSum = input + output + cache_create + cache_read` in all 4 components.

- [x] `tokens-view.tsx` — fixed
- [x] `agent-observability.tsx` — fixed
- [x] `task-tokens-view.tsx` — fixed
- [x] `token-usage-card.tsx` — fixed
- [x] Verify: `npx tsc --noEmit` — clean

## Verification

With a fresh CC session + new project:
1. Run full yolo pipeline (idea → proposal → reviewer → approve → dev → verify)
2. Check observability page: total tokens should match CC's reported total_tokens
3. Review phase should show reviewer's tokens (~23k), not 0 or 3.6k
4. Execution phase should show dev's tokens (~34k)
5. No tokens should leak into elaboration phase from reviewers
