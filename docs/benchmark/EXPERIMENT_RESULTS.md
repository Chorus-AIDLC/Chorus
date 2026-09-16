# PRDBench Experiment Results: Chorus vs CC Baseline

> Experiment date: 2026-04-01 ~ 2026-04-02
>
> Task: PRDBench #47 (Library Management System, 42 metrics, hardest pilot task)

## Summary

| Setup | Model | Score | Time | PASS | PARTIAL | FAIL |
|-------|-------|-------|------|------|---------|------|
| CC Baseline | Opus | **69.0%** | 686s | 16 | 26 | 0 |
| Chorus v7 (final) | Opus | **69.0%** | 2031s | 16 | 26 | 0 |
| CC Baseline | Sonnet | **50.0%** | 553s | 10 | 22 | 10 |
| Chorus | Sonnet | **36.9%** | 710-929s | 4-6 | 23 | 13-15 |
| CC Baseline | Haiku | **64.3%** | 417s | 15 | 24 | 3 |
| Chorus | Haiku | **14-36%** | 969-2289s | 3-5 | 5-24 | 15-32 |

**Key finding**: Chorus matches Opus baseline on score but takes ~3x longer. Chorus hurts Sonnet and Haiku performance significantly.

## Experiment Setup

- **Benchmark**: PRDBench (arXiv:2510.24358), 50 Python projects from PRDs
- **Task 47**: Library Management System — database, auth, CRUD, borrowing, statistics, CLI (42 test metrics)
- **Scoring**: Simplified scorer running test commands from `detailed_test_plan.json` (not PRDJudge)
- **Chorus flow**: Create Project → Idea → Skip Elaboration → Proposal (task DAG) → Self-Approve → Develop → Self-Verify

## Key Findings

### 1. Chorus harness effectiveness depends on model capability

Opus + Chorus = Opus baseline (69.0% = 69.0%). The structured workflow doesn't hurt but doesn't help either — Opus is strong enough to produce equivalent code with or without Chorus scaffolding.

Haiku + Chorus = much worse than Haiku baseline (35.7% << 64.3%). Chorus is a net negative for weaker models because:
- Haiku burns turns on Chorus workflow overhead (project/idea/proposal/verify)
- Haiku creates too many tasks (8-10 vs Opus's 5-6), splitting work too thin
- Haiku's debug loop is inefficient (3-5 rounds per test failure vs Opus's 1-2)
- Haiku loses MCP tool usage patterns in long conversations, degrades to Bash+Python workarounds

### 2. Test-driven Acceptance Criteria are essential

Without test ACs in the proposal, Chorus score was 27-32%. With test ACs mapped to each task, score jumped to 69%.

The test AC approach forces the agent to run specific test commands before submitting each task, catching interface mismatches and logic errors early. Without it, the agent writes code that "looks right" but doesn't match evaluation test expectations.

### 3. PRD ACs prevent "teaching to the test"

When only test ACs were used, the agent implemented the minimum to pass tests but skipped PRD requirements not covered by tests (e.g., reservation queue auto-processing on return). Adding PRD ACs fixed this — v7 correctly implemented `_process_reservation_queue` which earlier versions missed.

### 4. Evaluation file integrity matters

PRDBench task 47's evaluation test files have 1-space indentation (Python syntax errors). When evaluation files were read-only (`chmod a-w`), agents couldn't fix them → tests failed → scores dropped. When writable, Opus fixed them automatically; Haiku couldn't.

The original evaluation files also have filename mismatches (`test_2_1_用户注册功能.py` vs referenced `test_2_1_user_registration.py`). These are benchmark bugs, not agent issues.

### 5. Chorus produces comparable code quality with different trade-offs

**Chorus advantages** (observed in v7 vs baseline):
- `reserve_book` has auth check — baseline doesn't
- `BorrowResult` with `__bool__`/`get()` support — more Pythonic
- `resolve_filepath` helper for robust file imports
- More comprehensive seed data (enables tests to pass)
- `_process_reservation_queue` actually executes state transitions — baseline only prints a notification

**Baseline advantages**:
- Better code organization (separate `ui/menus.py`, `models/`, `ServiceResult` class)
- More helper methods (`get_all_borrows`, `get_all_reservations`, `get_low_stock_books`)
- Consistent return value patterns across all services
- Less code duplication

### 6. Haiku context degradation pattern

Analyzed Haiku's CC session logs (conversation `70822f5d`). The pattern:

1. **Turns 1-50**: Correctly uses Chorus MCP tools (checkin, create project, idea, proposal, approve)
2. **Turns 50-100**: Claims tasks, starts implementing, begins running tests via Bash
3. **Turns 100-150**: Debug loops dominate — read test file → edit code → run test → fail → repeat
4. **Turns 150+**: Forgets MCP tools entirely, attempts to call Chorus API via `python subprocess` in Bash. Never recovers.

Root cause: Haiku's context window management degrades in long conversations. The MCP tool usage pattern from early turns gets "diluted" by hundreds of Bash/Edit/Read calls during debug loops.

### 7. Sonnet failure pattern: premature exit and task over-splitting

Sonnet exhibits different failure modes from Haiku:

**Over-splitting**: Without task count limits, Sonnet created 17 tasks for a single project. Even with a 3-6 task limit, Sonnet's T3 (User Management) accumulated 10 test runs across 5 different test types (registration, login, password encryption, student ID validation, password validation), consuming 39 tool calls on a single task.

**Premature exit**: After completing 2-3 tasks (~130 tool calls, well within 300 turn limit), Sonnet outputs "Due to conversation length..." and stops. This is not a turns limit — it's Sonnet **self-assessing** that the conversation is too long and choosing to quit. Adding "never stop early" to the PE helps but doesn't fully prevent this behavior.

**Agent Teams attempt**: When prompted to use Agent Teams, Sonnet tried to spawn sub-agents but failed to coordinate them (`TeamDelete` after coordination issues), then fell back to direct implementation. The Agent Teams feature adds complexity that Sonnet cannot reliably manage.

**Compared to Haiku**: Haiku keeps trying until turns run out (but inefficiently). Sonnet makes strategic decisions to stop — sometimes wisely (spawning subagents in the 17-task run, scoring 41.7%) but usually prematurely (quitting at task 3/6 with "conversation too long").

**Compared to Opus**: Opus completes all tasks without hesitation or strategic compromises. It doesn't over-split (5-6 tasks), doesn't need multiple debug rounds per test (usually passes first try), and never considers stopping early.

## PE Evolution

| Version | Key PE Change | Opus Score | Notes |
|---------|--------------|------------|-------|
| v1 | No eval protection | 27.4% | Agent corrupted evaluation files |
| v2 | `chmod a-w evaluation/` | 32.1% | Tests couldn't run (1-space indent bug) |
| v3 | Test ACs in proposal | 69.0% | Major improvement |
| v4 | + PRD ACs | 69.0% | Caught missed requirements |
| v5 | Simplified PE (skills-based) | — | Agent skipped Chorus entirely |
| v6 | + Explicit self-approve/verify | 66.7% | Worked but no dev self-test |
| v7 | + Mandatory self-test step | **69.0%** | Final version, 0 FAIL |

### Final PE structure (v7)

```
1. PRDBench official DEVELOPMENT_PROMPT (same as baseline)
2. Chorus pipeline: 7 steps referencing /chorus:* skills
3. Key additions vs baseline:
   - "You are Admin with all roles, no one else will do it"
   - "Self-approve proposal"
   - "MANDATORY SELF-TEST before submitting each task"
   - "Self-verify every task"
4. AC rules: Test ACs + PRD ACs, each directly related to task scope
```

## Limitations

1. **Simplified scorer** — String matching, not PRDJudge (LLM evaluator). All PARTIAL scores could be PASS or FAIL with proper evaluation. True scores likely higher for both sides.
2. **Single task** — Only tested on PRDBench #47. Results may differ on simpler tasks (Task 10 showed similar pattern but less pronounced).
3. **Non-deterministic** — Same setup can produce different results across runs. Would need 3-5 runs per configuration for statistical significance.
4. **Chorus overhead** — ~3x time cost is partly inherent (MCP calls, proposal creation) and partly from our PE requiring self-test/verify. A production Chorus setup with separate PM/Dev agents might be more efficient.

## Recommendations

1. **Chorus requires Opus-class models** — Sonnet and Haiku both perform worse with Chorus than without. Sonnet quits early; Haiku burns turns on debug loops. Only Opus has enough capability to handle Chorus workflow overhead while maintaining code quality.
2. **Test-driven ACs are non-negotiable** — Without them, Chorus adds overhead without quality benefit.
3. **Keep task count reasonable** — The PE should not suggest a specific number, but the AC guidance "each AC must be directly related to THIS task's scope" helps prevent over-splitting.
4. **Chorus needs a cross-module consistency mechanism** — Filed as Chorus idea: agents implementing separate tasks lack global view of return value formats, module interfaces, and inter-module behaviors.
5. **PRDBench evaluation files need fixing** — 1-space indentation and filename mismatches are benchmark bugs that affect all agents.
