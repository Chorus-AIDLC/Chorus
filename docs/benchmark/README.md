# Benchmark Research: Evaluating Chorus as a Coding Agent Harness

> Research date: 2026-04-01
>
> Goal: Identify existing benchmarks and methodologies to measure how Chorus improves Claude Code's software engineering performance.

## Deep-Dive Research

| Benchmark | Focus | Relevance | Document |
|-----------|-------|-----------|----------|
| **SWE-bench Pro** | Single-issue resolution, harness A/B testing | Scaffold comparison gold standard | [SWE_BENCH_PRO.md](./SWE_BENCH_PRO.md) |
| **Terminal-Bench 2.0 & Meta-Harness** | Terminal tasks, scaffold optimization | Purpose-built for harness comparison | [TERMINAL_BENCH.md](./TERMINAL_BENCH.md) |
| **ProjDevBench** | End-to-end project construction | Project-level development evaluation | [PROJDEVBENCH.md](./PROJDEVBENCH.md) |
| **PRDBench** | PRD → complete project, multi-modal evaluation | PRD-to-project aligns with Chorus Proposal workflow | [PRDBENCH.md](./PRDBENCH.md) |
| **MARBLE (MultiAgentBench)** | Multi-agent coordination quality | Multi-agent collaboration metrics | [MARBLE.md](./MARBLE.md) |

## Background

The AI coding agent ecosystem in 2025-2026 has reached a critical insight: **scaffold/harness engineering is now more impactful than model selection**. Multiple studies confirm that the same model can show 20+ point performance swings depending on the framework wrapping it. This makes rigorous harness evaluation essential — and directly relevant to Chorus's value proposition.

Key quote from OpenAI Codex team: *"Agents aren't hard; the Harness is hard."*

## 1. Benchmarks for Harness/Scaffold Evaluation

### [SWE-bench Pro](./SWE_BENCH_PRO.md) (Scale AI, 2025)

- **Scale**: 1,865 tasks across 41 repositories in Python, Go, TypeScript, JavaScript
- **Task profile**: Average 107 lines changed across 4.1 files (vs. 11 lines/1 file in SWE-bench Verified)
- **Anti-contamination**: Includes proprietary codebases; models can't have trained on test data
- **Key finding**: Scaffold accounts for 22+ point performance swings with identical models — same model scores 23% with basic tooling vs 45%+ with optimized 250-turn scaffolds
- **Top scores (public set, 731 tasks)**: GPT-5.4 (57.7%), Gemini 3.1 Pro (54.2%), Opus 4.5 (45.89%), Opus 4.5 + optimized harness (51.80%)
- **Relevance**: High. Can directly compare "CC alone" vs "CC + Chorus" on the same task set. Industry-standard, credible results.
- **Limitations**: Still measures single-issue resolution, not multi-task workflows.

### [Terminal-Bench 2.0](./TERMINAL_BENCH.md) (2025)

- **Scale**: 89 terminal tasks across 23 scaffolds with 101 agent configurations
- **Key finding**: Average task correlation ρ=0.30 (highest among agent benchmarks). LangChain agent jumped from outside top-30 to top-5 by changing only the harness, not the model.
- **Relevance**: Purpose-built for harness comparison. Could directly benchmark Chorus's scaffold quality.
- **Limitations**: Tasks are terminal-oriented, not full software engineering workflows.

### [Meta-Harness](./TERMINAL_BENCH.md#meta-harness-2026-llms-optimizing-their-own-scaffolds) (2026)

- **Concept**: LLMs autonomously optimize their own scaffolding using full execution traces (up to 10M tokens)
- **Result**: Topped TerminalBench-2 using Claude Haiku — a weaker model with better harness beat stronger models
- **Relevance**: Demonstrates the ceiling for harness optimization. Chorus could be evaluated as a "human-designed harness" vs Meta-Harness's "auto-optimized harness."

## 2. End-to-End Project Development Benchmarks

### [ProjDevBench](./PROJDEVBENCH.md) (Feb 2026)

- **Scale**: 20 C++ problems across 8 categories
- **Task profile**: Complete repository construction from requirements — not bug fixes, but building from scratch
- **Effort**: Agents average 138 interaction turns and 4.81M tokens per problem; hardest tasks take 2+ hours
- **Evaluation**: Dual scoring — Online Judge testing (80 points) + LLM-assisted code review for architecture quality (20 points)
- **Top scores**: Codex/GPT-5 at 77.85%
- **Relevance**: Very high. Tests project-level development which maps well to Chorus's Idea → Proposal → Task → Execute pipeline.
- **Limitations**: C++ only, small dataset.

### [PRDBench](./PRDBENCH.md) (2026)

- **Scale**: 50 project-level tasks across 20 sub-domains
- **Task profile**: PRD → complete project implementation, with 1,200+ scoring points
- **Evaluation**: EvalAgent — a multi-modal agent-as-judge with file I/O, shell execution, image processing (81.56% human consistency)
- **Relevance**: High. PRD-to-project aligns with Chorus's Proposal-to-implementation workflow.

### FEA-Bench (Feature Implementation)

- **Scale**: 83 GitHub repos with filtered PRs
- **Task profile**: Adding new features to existing codebases (not bug fixing)
- **Key finding**: LLMs perform "significantly worse" on feature implementation than function-level benchmarks
- **Relevance**: Medium-high. Feature implementation is closer to real development work that Chorus orchestrates.

### SWE-EVO (Long-Horizon Evolution)

- **Task profile**: Interpret release notes → implement multi-PR changes over time
- **Top score**: GPT-5 resolves only 21% (vs 65% on SWE-bench Verified)
- **Relevance**: High. Long-horizon, multi-step changes are exactly where Chorus's task DAG and session management should shine.

## 3. Multi-Agent Collaboration Benchmarks

### [MARBLE / MultiAgentBench](./MARBLE.md) (2025)

- **First comprehensive benchmark** for LLM-based multi-agent systems
- **Scenarios**: Cooperative and competitive — research co-authoring, Minecraft building, database analysis, coding collaboration
- **Metrics**: Novel milestone-based KPIs beyond task completion — coordination quality, structured planning scores, communication metrics
- **Relevance**: Directly tests multi-agent coordination, which is Chorus's core value proposition.
- **Limitations**: Not specifically focused on software engineering.

### FSD-Bench (Full-Stack Development, 2025)

- **Task profile**: Multi-agent frameworks build websites, desktop apps, and games
- **Results**: RTADev 63.83% vs ChatDev 41.02% vs MetaGPT 34.69%
- **Evaluation**: Automated feature completeness testing
- **Relevance**: Directly compares multi-agent software development frameworks.

### ChatDev Evaluation (ACL 2024)

- **Methodology**: Four dimensions — Completeness, Executability, Consistency, Overall Quality
- **Results**: ChatDev 0.40 overall quality vs MetaGPT 0.15 vs GPT-Engineer 0.14
- **Cost data**: Average $0.30 and 409s per small project
- **Relevance**: Established methodology for comparing multi-agent development frameworks. Could adapt the four-dimension scoring for Chorus evaluation.

## 4. Supporting Evidence: Harness Impact Data

### Bare Model vs Model + Framework

| Study | Bare/Basic | With Optimized Harness | Delta |
|-------|-----------|----------------------|-------|
| SWE-bench Pro (same model) | 23% | 45%+ | +22 pts |
| Anthropic CC internal | baseline | 2x success rate | +100% |
| CORE-Bench (Opus 4.5) | 42% (constrained scaffold) | 95% (unconstrained) | +53 pts |
| Augment Code (Opus 4.5) | 45.89% | 51.80% | +5.9 pts |

### Cost Efficiency

- Vexp Benchmark: Same model, same accuracy (~70-73%), but cost ranges from $0.67 to $1.98/task depending on scaffold (3x difference)
- Chorus's value may show more clearly in cost/token efficiency than raw accuracy at frontier level

### Human Intervention Reduction

- Anthropic internal: Human interventions dropped from 5.4 to 3.3 per session with improved CC scaffold (Aug-Dec 2025)
- This metric is directly measurable with Chorus

## 5. Contamination and Validity Concerns

| Benchmark | Contamination Risk | Mitigation |
|-----------|-------------------|------------|
| SWE-bench Verified | Severe — OpenAI stopped using it (March 2026). Models produce verbatim gold patches | Avoid for frontier model comparison |
| SWE-bench Pro | Low — includes proprietary repos, multi-language | Recommended for controlled studies |
| SWE-bench-Live | None — fresh unseen issues | Scores drop to ~19% (vs 80%+ Verified) |
| ProjDevBench | Low — from-scratch construction | Good for architecture evaluation |
| Terminal-Bench 2.0 | Low — diverse terminal tasks | Good for harness comparison |

## 6. Key Methodological Insights

### METR Time Horizon Method

- Tasks categorized by "time a human expert would need" (15min, 1hr, 4hr, etc.)
- Models succeed 60% on <15min tasks but only 10% on >4hr tasks
- Chorus's value should increase with task complexity — test on longer-horizon tasks

### Grade Outcomes, Not Paths (Anthropic)

- Don't check for specific tool call sequences — agents find valid approaches designers didn't anticipate
- Use execution-based evaluation (tests pass/fail) over trajectory matching
- Three grader types: code-based (fast), model-based (handles nuance), human (gold standard)

### Milestone-Based KPIs (MARBLE)

- Beyond binary pass/fail: measure intermediate milestones achieved
- Applicable to Chorus's multi-step pipeline: did the agent correctly decompose tasks? Create valid proposals? Handle dependencies?

## 7. Recommended Evaluation Strategy for Chorus

### Phase 1: Quick Wins with Existing Benchmarks

**A/B comparison on SWE-bench Pro (731 public tasks)**

| Group | Setup | Metrics |
|-------|-------|---------|
| Control | CC (Claude Code) running alone | Resolve rate, cost/task, tokens/task, time/task |
| Treatment | CC + Chorus harness (Idea → Task → Execute → Verify) | Same metrics |

- Infrastructure exists (Docker-based evaluation)
- Results are industry-comparable
- Can show harness delta with same underlying model

**Terminal-Bench 2.0 as secondary validation**

- Confirms harness effect is not benchmark-specific

### Phase 2: Project-Level Evaluation

**ProjDevBench or PRDBench tasks**

- Tests Chorus's strength in project planning and architecture
- Measures quality dimensions beyond "tests pass"
- Aligns with Chorus's Proposal → Document + Task pipeline

### Phase 3: Chorus-Specific Benchmark (Custom)

Build a benchmark targeting Chorus's unique capabilities:

| Dimension | What to Measure | Method |
|-----------|----------------|--------|
| Task decomposition quality | Are generated Task DAGs reasonable? | Expert review + dependency validity check |
| Multi-agent coordination | Parallel agent efficiency, conflict resolution | Instrumented Chorus sessions |
| Review/verify loop | Does verification catch real issues? | Inject known bugs, measure detection rate |
| Human intervention reduction | Interventions per feature delivered | Comparative study: CC alone vs CC + Chorus |
| End-to-end cycle time | Idea → Merged PR elapsed time | Real project measurement |
| Cost efficiency | $/feature at equivalent quality | Token + API cost tracking |

**Data source options:**
- Chorus's own issue history (dog-fooding)
- Open-source projects with well-documented issues
- FEA-Bench tasks (feature implementation in real repos)
- SWE-EVO tasks (long-horizon, multi-step evolution)

### Phase 4: Longitudinal Study

Inspired by METR's time horizon method:
- Track Chorus-assisted development over weeks/months
- Measure whether the harness effect grows with task complexity
- Compare against published baselines (METR's GPT-5 ~2hr 17min time horizon)

## References

- SWE-bench: https://www.swebench.com/
- SWE-bench Pro: Scale AI, 2025
- Terminal-Bench 2.0: 2025
- ProjDevBench: arXiv, Feb 2026
- MARBLE/MultiAgentBench: 2025
- FSD-Bench: RTADev, 2025
- ChatDev evaluation: ACL 2024
- METR time horizon analysis: https://metr.org/blog/
- Anthropic harness findings: Anthropic engineering blog
- Meta-Harness: 2026
- PRDBench: arXiv 2503.06680
- FEA-Bench: OpenReview ICLR 2025
- SWE-EVO: arXiv 2512.18470
- BFCL v4: Berkeley, 2024-2025
