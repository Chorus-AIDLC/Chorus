# Terminal-Bench 2.0 and Meta-Harness: A Technical Deep Dive

## Terminal-Bench 2.0: The Frontier Agent Benchmark

### Overview

Terminal-Bench 2.0 is a rigorous benchmark for evaluating AI agents on realistic, high-skill terminal-based tasks. Created by Mike Merrill, Alex Shaw, and a team of 85+ contributors under the Laude Institute (with roots at Stanford), it was released in November 2025 as an evolution of the original Terminal-Bench 1.0 (May 2025). The benchmark addresses a critical gap: existing agent benchmarks either lacked real-world relevance or were too easy to meaningfully differentiate frontier models. As of early 2026, Terminal-Bench 2.0 has become the de facto industry standard for agent evaluation, used by virtually every major AI lab.

The benchmark's core philosophy: tasks must be **hard** (frontier models score under 65%), **realistic** (inspired by actual professional workflows), and **verifiable** (comprehensive automated tests with human validation). Each task underwent rigorous quality checks averaging 3+ person-hours: canary tests, static analysis, LLM-assisted audits, code review, smoke testing with dummy agents, and adversarial audits. This investment ensures specifications are unambiguous, tasks are solvable, and shortcuts are impossible.

### The 89 Tasks: Categories and Difficulty

Terminal-Bench 2.0 comprises 89 carefully curated tasks spanning ten technical domains. The difficulty distribution mirrors real engineering timelines: 8% solvable by junior engineers in under an hour, 72% within one workday, and 4% requiring over a week. No single category dominates, forcing agents to generalize across diverse technical landscapes.

**Task categories include:**
- **Software Engineering**: Complex git operations (`git-multibranch` with merge conflicts), compiler toolchains (`build-linux-kernel-qemu` requiring custom kernel compilation and QEMU verification)
- **Machine Learning**: Model training under constraints (`train-fasttext` demanding <150MB model size with 0.62+ accuracy on private test sets), hyperparameter optimization, inference batching schedulers
- **Security Engineering**: Vulnerability analysis, secure configuration, penetration testing workflows
- **Data Science**: Statistical analysis, data pipeline construction, visualization tasks
- **System Administration**: Server setup, network configuration, resource monitoring
- **Scientific Computing**: Numerical simulations, code coverage analysis (`sqlite-with-gcov`)
- **Game Playing**: Strategic reasoning (`chess-best-move` using chess engines)
- **Biology & Computational Science**: Domain-specific analysis pipelines
- **Debugging**: Reverse-engineering (`path-tracing` reconstructing C programs from rendered images)
- **DevOps**: CI/CD pipeline configuration, containerization workflows

Example task: `LLM inference batching scheduler` requires implementing shape-aware batching for static-graph LLM inference systems, minimizing wasted compute while managing cold compilations and latency. Tasks feature unique Docker environments preconfigured with necessary dependencies, natural-language instructions, and comprehensive pytest-based verification suites.

### Scaffold Comparison Methodology: 23 × 101 = 2,323 Configurations

Terminal-Bench 2.0's leaderboard represents the most comprehensive agent scaffold comparison ever conducted. At the time of systematic analysis (March 2026), the benchmark contained **101 agent configurations** drawn from **23 distinct scaffolds** across multiple model families. This yields 2,323 unique agent-scaffold-model combinations.

**Major scaffolds tested:**
- **Terminus 2 / Terminus-KIRA**: Open baseline agents developed by the Terminal-Bench team
- **Claude Code**: Anthropic's first-party agent
- **Codex CLI**: OpenAI's official command-line agent
- **OpenHands**: Cloud-based agent (formerly SWE-Agent)
- **Aider**: Lightweight open-source coding assistant
- **Mini-SWE-Agent**: Princeton's compact scaffold
- **Goose**: Block's agent framework
- **Gemini CLI**: Google's terminal agent
- **Cursor CLI, Cline CLI**: IDE-integrated agents
- **Custom implementations**: Factory Droid, Mux, TongAgents, MAYA-V2, Capy, ForgeCode, DeepAgents, and 10+ proprietary scaffolds

**Controlled evaluation methodology:**
- Each agent-task pair is attempted **5 times**, yielding fractional success rates
- Execution occurs in **Harbor-managed containers** (via Daytona, E2B, or Modal) with 32-100 parallel instances
- Time limits (not turn limits) enforce realistic constraints—agents must budget time effectively
- Programmatic verification through pytest suites executing in isolated Docker environments
- All evaluation logs stored in HuggingFace repos for reproducibility

The benchmark's temporal structure enables generalization testing: 50 agents were present at launch (October 2025), while 51 were added over the following 3.5 months across 17 new scaffold types. This allows researchers to validate whether task selection generalizes to novel architectures.

### Key Results: The Scaffold Problem

**Top performers (as of March 2026):**
1. GPT-5.2 + Codex CLI: 62.9%
2. Claude Opus 4.5 + Terminus 2: 57.8%
3. Gemini 3 Pro + Terminus 2: 56.9%
4. GPT-5.2 + Terminus 2: 54.0%
5. Claude Opus 4.5 + Claude Code: 52.1%

**Critical finding: The task-level correlation is 0.30** (average pairwise Spearman correlation between task outcome vectors). This is the highest among all major agent benchmarks—SWE-bench Verified shows 0.29, while GAIA (0.15), CoreBench (0.10), and TAU-bench (0.08) exhibit far lower consistency. Higher correlation indicates agent performance patterns are more consistent across tasks, providing cleaner signal for ranking.

**The LangChain harness-swap story:** LangChain's DeepAgents team demonstrated the scaffold's dramatic impact by jumping from #30 to #5 (52.8% → 66.5%, a 13.7-point improvement) using GPT-5.2-Codex while changing **only the harness**. Their approach: (1) upfront environmental context ("15-minute waterfall"), (2) forced verification against original specs rather than self-review, (3) explicit prompting about test standards, (4) time budget warnings for timeout-prone tasks, and (5) reasoning effort tuning (xhigh caused timeouts; high achieved 63.6%). This represents the birth of **harness engineering** as a discipline distinct from prompt engineering.

Model selection typically matters more than scaffold choice—Codex CLI with GPT-5.2 (+52% vs. GPT-5-Nano) outperforms Gemini-2.5-Pro scaffold swaps (+17%)—but at equal model capability, scaffold deltas of 5-10% are common and economically significant.

### How to Run It: Harbor Framework

Terminal-Bench 2.0 is distributed via **Harbor**, a framework for containerized agent evaluations released November 2025. Harbor emerged when the team observed Terminal-Bench being repurposed for CI/CD testing, RL training loops, and prompt optimization—all requiring the same abstraction: containerized rollouts returning tokens and rewards.

**Setup:**
```bash
# Install Harbor (requires Python 3.12+, Docker, and uv)
uvx harbor run -d terminal-bench@2.0 -a oracle  # Sanity check

# Run with Claude Code on Daytona (cloud containers)
export DAYTONA_API_KEY="..."
export ANTHROPIC_API_KEY="..."
harbor run \
  -d terminal-bench@2.0 \
  -m anthropic/claude-haiku-4-5 \
  -a claude-code \
  --env daytona \
  -n 32  # Parallel containers
```

**Adding your own scaffold:** Harbor supports any agent installable in a container. Create an adapter implementing `BaseAgent` with a `run()` method that wraps your agent's execution. LangChain's DeepAgents example shows integration via `HarborSandbox` backend providing filesystem tools over shell commands.

**Registry:** Harbor serves 20+ benchmarks beyond Terminal-Bench: SWE-bench Verified, ReXBench, MLGym-Bench, FeatureBench, GPQA-Diamond, and domain-specific suites. All tasks follow a unified format: `instruction.md`, `tests/test.sh`, `task.toml`, `environment/Dockerfile`, and optional `solution/` oracles.

### Metrics Beyond Pass/Fail

While binary success/failure is the primary metric, Harbor's execution traces capture:
- **Token usage**: Input/output tokens per task (e.g., Claude Code on Opus 4.5: 256.9M input, 0.8M output)
- **Latency**: Time-to-completion distributions, timeout rates
- **Cost**: Dollar estimates via API pricing (critical for production deployment decisions)
- **Tool invocation patterns**: Which commands agents execute, in what order
- **Error logs**: Verifier output, agent logs, reward signals for RL
- **Trajectory data**: Full ATIF (Agent Task Interaction Format) traces exportable as ShareGPT for SFT

These metrics enable economic analysis: Haiku 4.5 at $5.10/day for 1k requests vs. Sonnet 4.5 at $15.30 (67% savings) informs scaffold/model selection for sub-agent orchestration.

---

## Meta-Harness (2026): LLMs Optimizing Their Own Scaffolds

### Concept: Autonomous Harness Evolution

Meta-Harness, released in March 2026 by Yoonho Lee and collaborators from Stanford (with Chelsea Finn and Omar Khattab), represents a paradigm shift: **LLMs autonomously optimizing their own scaffolds**. The key insight: harness engineering requires solving a hard, long-horizon credit-assignment problem over all prior code, execution traces, and scores—information that existing text optimizers compress too aggressively.

Traditional text optimization methods (OPRO, TextGrad, AlphaEvolve, GEPA, OpenEvolve) condition on scalar scores, recent solutions, or fixed summaries. This lossy compression discards long-range dependencies needed to trace downstream failures to earlier harness decisions. Meta-Harness takes a radically different approach: **give the optimizer access to everything**.

**What's a harness?** The stateful program wrapping an LLM that determines what information to store, retrieve, and present at each step. It includes system prompts, tool definitions, context management, memory systems, verification loops, error recovery, execution runtime, and guardrails. The equation: **Agent = Model + Harness**.

### Methodology: 10M Token Execution Traces

Meta-Harness uses an **agentic proposer** (Claude Code) that accesses full history through a **filesystem**. For every prior candidate harness, the system stores source code, evaluation scores, and execution traces. The proposer retrieves what it needs via standard tools (`grep`, `cat`, `find`) rather than ingesting everything as a single prompt.

**Scale:** In practice, the proposer reads a median of **82 files per iteration**, referencing 20+ prior candidates per step. A single evaluation can produce **up to 10,000,000 tokens** of diagnostic information—three orders of magnitude beyond the largest feedback budgets used in prior text optimization (26K tokens max for competitors). This enables the proposer to trace a failure back to the specific harness decision that caused it, rather than guessing from a score.

**Search process:**
1. Initialize from strong baselines (Terminus 2, Terminus-KIRA)
2. Proposer reads prior trials, forms hypotheses about failure modes
3. Rewrites harness components (prompts, tools, completion logic, context management)
4. Evaluates on task subset, logs full traces
5. Iterates based on diagnostic signals

Example evolution: On a 19-task hard subset (baseline 28.5%), Meta-Harness reaches 46.5% by iteration 7, diagnosing issues like "agent doesn't understand programmatic testing standards" or "timeouts from excessive iteration" and injecting targeted fixes.

### Results: Haiku Beats Stronger Models

**TerminalBench-2 full benchmark:**

| Claude Opus 4.6 | Pass % | | Claude Haiku 4.5 | Pass % |
|-----------------|--------|---|------------------|---------|
| Claude Code | 58.0 | | OpenHands | 13.9 |
| Terminus 2 | 62.9 | | Claude Code | 27.5 |
| Terminus-KIRA | 74.7 | | Terminus 2 | 28.3 |
| **Meta-Harness** | **76.4** | | Mini-SWE-Agent | 29.8 |
| ForgeCode | 81.8* | | Goose | 35.5 |
| | | | **Meta-Harness** | **37.6** |

*ForgeCode's 81.8% could not be reproduced from public code, suggesting undisclosed components.

**Claude Haiku 4.5 impact:** Meta-Harness achieves 37.6%, outperforming the next-best Haiku agent (Goose, 35.5%) by 2.1 points and ranking **#1 among all Haiku 4.5 agents**. This is remarkable: a weaker, faster, cheaper model ($0.001/1K input tokens) outperforming hand-engineered harnesses for the same base model through pure scaffold optimization.

On Opus 4.6, Meta-Harness reaches 76.4%, surpassing Terminus-KIRA (74.7%) and ranking **#2 among all Opus agents**. The improvement margin is smaller on stronger models, suggesting harness optimization yields greater returns when the base model is less capable.

**Other domains:**
- **Online text classification:** Discovered harness achieves 48.6% vs. ACE's 40.9% (7.7-point gain) using **4× fewer context tokens**. Gains concentrate on large label spaces: LawBench (+16 points, 215 classes), Symptom2Disease (+9 points).
- **Retrieval-augmented math reasoning:** Single harness improves accuracy on 200 IMO-level problems by 4.7 points on average across five held-out models.

### Implications: The Future of Harness Engineering

**1. Harness > Model in some regimes:** Meta-Harness demonstrates that scaffold optimization can overcome substantial model capability gaps. Haiku 4.5 with an optimized harness beats Opus 4.1 with naive scaffolds (37.6% vs. 34.8% on Claude Code). This inverts the traditional scaling assumption.

**2. Self-assembling infrastructure:** We're likely heading toward agent systems that autonomously optimize their own execution harnesses based on deployment telemetry. The "meta-harness is itself a harness" recursive structure suggests arbitrarily deep optimization loops.

**3. Economic implications:** At scale, a 10% harness improvement on a cheaper model saves more than upgrading to a 2× more expensive model with similar gains. Production teams now face a build-vs-buy decision: invest in harness engineering or wait for better models.

**4. Benchmark lifecycle management:** As harnesses improve, benchmarks saturate faster. Terminal-Bench 2.0 maintains headroom (top score 63% at launch), but Meta-Harness's 76% suggests Terminal-Bench 3.0 will be needed soon.

**5. Portability concerns:** Natural-language harnesses (NLAHs, concurrent research from Tsinghua/HIT) may emerge as the standard for specifying behavior, enabling teams to share and benchmark harnesses like we do models.

**6. Credit assignment solved?** Meta-Harness solves long-horizon credit assignment by brute force: give the optimizer unlimited context via filesystem access. This scales only because retrieval is selective (82 files, not 10M tokens in prompt). Future work may compress traces while preserving diagnostic utility.

The rise of harness engineering marks a maturation point for AI agent development. Teams investing now in systematic harness optimization, trace collection, and evaluation infrastructure will have a compounding advantage as base model improvements slow and scaffold engineering becomes the primary lever for capability gains.

---

**Word count: 1,196**
