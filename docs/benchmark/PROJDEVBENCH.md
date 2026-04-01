# ProjDevBench: Technical Overview

## 1. Overview

**ProjDevBench** is an end-to-end benchmark for evaluating AI coding agents on complete software project development, published February 2, 2026 (arXiv:2602.01655). Unlike prior benchmarks focused on bug fixes (SWE-bench) or single functions (HumanEval), ProjDevBench requires agents to build full, executable repositories from natural-language specifications with no starter code.

**Authors**: Pengrui Lu, Shiqi Zhang, Yunzhong Hou, Lyumanshan Ye, Chaoyi Huang, Zixi Chen, Ji Zeng, Hantao Jiang, Pengfei Liu, Yiwei Wang, Ming-Hsuan Yang

**Gap Filled**: Bridges the evaluation gap between toy coding tasks and real-world system-level engineering. Existing benchmarks provide complete repository structures or staged materials; ProjDevBench gives agents a blank slate and evaluates architecture design, cross-module integration, resource management, and iterative refinement under strict constraints.

**Repository**: https://github.com/zsworld6/projdevbench  
**Paper**: https://arxiv.org/abs/2602.01655  
**License**: MIT

---

## 2. Dataset Structure

### 20 Problems Across 8 Categories

| ID | Problem | Category | Difficulty | Time Limit | Memory Limit | Avg Score |
|----|---------|----------|------------|------------|--------------|-----------|
| 001 | A+B Problem | Algorithm | Easy | 1s | 256 MiB | 54.37 |
| 002 | int2048 Big Integer | Algorithm | Easy | 10s | 190 MiB | 48.19 |
| 003 | ICPC Management System | Management | Hard | 2s | 512 MiB | 52.07 |
| 004 | Bookstore System | Management | Hard | 10s | 64 MiB | 36.29 |
| 005 | QOI Format Codec | Algorithm | Easy | 10s | 512 MiB | 58.87 |
| 006 | Minesweeper | Game | Easy | 30s | 256 MiB | 53.51 |
| 007 | BASIC Interpreter | Interpreter | Easy | 5s | 256 MiB | 47.67 |
| 008 | MOV Language | Assembly | Easy | — | — | 54.70 |
| 009 | STLite Vector | Data Structure | Easy | 100s | 768 MiB | 58.46 |
| 010 | STLite List | Data Structure | Easy | 25s | 768 MiB | 30.76 |
| 011 | STLite Priority Queue | Data Structure | Easy | 15s | 512 MiB | 57.25 |
| 012 | STLite Linked HashMap | Data Structure | Easy | 24s | 893 MiB | 43.36 |
| 013 | STLite Map | Data Structure | Easy | 30s | 893 MiB | 58.21 |
| 014 | Python Interpreter | Interpreter | Easy | 16s | 512 MiB | 46.23 |
| 015 | File Storage | Storage | Hard | 16s | 6 MiB | 42.71 |
| 016 | File Storage BPT | Storage | Hard | 5s | 64 MiB | 40.11 |
| 017 | Train Ticket System | Management | Hard | 40s | 47 MiB | 53.24 |
| 018 | Scheme Interpreter | Interpreter | Easy | 1.5s | 244 MiB | 32.94 |
| 019 | GPU Memory Optimization | Optimization | Easy | 1s | 244 MiB | 36.89 |
| 020 | Buddy Algorithm | Optimization | Easy | 10s | 244 MiB | 33.33 |

### Input Provided

Each problem provides:
- **README.md**: Natural-language specification (high-level requirements only)
- **submit_acmoj/**: Online Judge submission client
- **Test data**: Mounted read-only at runtime

**Easy vs Hard**:
- **Easy**: Agent starts from scratch (Project-Creation mode)
- **Hard**: Agent receives minimal starter scaffold (Project-Completion mode)

No reference solutions, detailed pseudocode, or test case contents are provided to agents.

---

## 3. Evaluation Methodology

### Dual Scoring System (80/20 Split)

**Final Score = 0.8 × Execution Score + 0.2 × Code Review Score**

#### Stage 1: Online Judge Execution (80 points)

Agents submit compiled artifacts to an OJ platform that runs weighted test cases with strict resource limits.

**Execution Score Formula**:
```
S_exec = (Σ w_i · 1[test_i passed] / Σ w_i) × 100
```

**Verdicts Returned**:
- Accepted (27.38% overall)
- Wrong Answer (41.86%)
- Time Limit Exceeded (13.91%)
- Runtime Error (7.01%)
- Compile Error (4.52%)
- Memory Leak (3.51%)
- Memory Limit Exceeded (1.36%)
- Others (0.45%)

Test cases have variable weights (w_i) reflecting importance/difficulty. The OJ evaluates end-to-end executability, functional correctness, edge cases, and compliance with time/memory constraints.

#### Stage 2: LLM-Assisted Code Review (20 points)

**Two-Part System**:
1. **Rule-based automated checks** (Python scripts, JSON rule lists at `scripts/cr/[problem_id]/cr_list.json`)
2. **LLM qualitative evaluation** (architecture, style, potential cheating)

Code Review detects:
- Rule violations (naming, structure)
- Design flaws
- Security issues
- Hardcoded solutions

**Implementation**: `scripts/cr/common/checks.py` runs automated checks; LLM reviewers provide qualitative assessment (exact prompts not publicly released).

---

## 4. Agent Interaction Model

### Average Statistics Per Problem

- **Interaction turns**: 138 (median)
- **Token consumption**: 4.81 million tokens
- **Time per task**: Up to 2 hours for complex problems
- **Submission limit**: 2–18 attempts depending on problem complexity

### Workflow

1. Agent receives problem README in isolated Docker container
2. Agent initializes Git repo, creates GitHub remote
3. Agent iteratively designs, implements, tests, debugs
4. Agent submits to OJ via `oj_client.py` and receives verdicts
5. Agent refines based on feedback (Wrong Answer, TLE, Memory Leak, etc.)
6. Final score is max across all valid submissions within limit

### Interaction-Performance Correlation

**Strong negative correlation** between interaction length and success:
- **Spearman ρ = -0.668** (turns vs. score)
- **Spearman ρ = -0.734** (tokens vs. score)

**Interpretation**: Harder problems trigger more interaction but longer sessions don't guarantee success. Easy problems are solved quickly with high scores; difficult problems consume massive tokens but often fail.

---

## 5. Current Results

### Agent-Model Combinations Tested

| Agent | Model | Exec Score | Code Review | Final Score |
|-------|-------|------------|-------------|-------------|
| Codex | GPT-5 | 76.73 | — | 77.85 |
| Cursor | Gemini 3 Pro | 72.52 | — | 75.32 |
| Augment | GPT-5 | 72.13 | — | 72.35 |
| Cursor | GPT-5 | 69.26 | — | 71.85 |
| Copilot | Claude Sonnet 4.5 | 62.48 | — | 67.18 |
| Claude Code | Claude Sonnet 4.5 | 63.76 | 89.31 | 68.87 |
| Claude Code | GLM-4.6 (open) | 52.00 | — | 57.95 |

**Overall acceptance rate**: 27.38% across all agents/tasks

**Key Findings**:
- **Frontier model convergence**: Top models differ by <1% on simple tasks
- **Framework impact**: Same model achieves vastly different scores on different agent frameworks (e.g., GPT-5 scores 76.73 on Codex vs. 69.26 on Cursor)
- **Model-agent interaction**: GPT-5 generally outperforms Sonnet 4.5 on execution, but Sonnet 4.5 achieves highest code review scores (89.31 on Claude Code)

### Systematic Failure Modes

1. **Specification alignment**: Misunderstanding requirements
2. **Edge-case handling**: Passing basic tests but failing corner cases
3. **Complexity optimization**: Solutions too slow (TLE)
4. **Resource management**: Memory leaks, exceeding limits
5. **System-level integration**: Cross-module dependency errors

---

## 6. How to Run It

### Prerequisites

- Docker & Docker Compose
- GitHub Personal Access Token (Fine-grained with repo create + contents write)
- Online Judge API token (`ACMOJ_TOKEN`)
- Agent-specific credentials (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, etc.)

### Setup

```bash
git clone https://github.com/zsworld6/projdevbench
cd projdevbench

# Configure tokens in config/environment.env
cp config/environment.env.example config/environment.env
# Edit: GITHUB_TOKEN, ACMOJ_TOKEN, agent keys

# Build Docker images
docker compose build

# Create logs directory with proper permissions
mkdir -p logs
chmod 777 logs
```

### Run Evaluation

```bash
# Single problem
AGENT=claude-code MODEL=claude-sonnet-4.5 PROBLEMS=001 \
  ./scripts/run_evaluation.sh

# Multiple problems with concurrency
AGENT=claude-code MODEL=claude-sonnet-4.5 \
  PROBLEMS=001,002,003 CONCURRENCY=3 \
  ./scripts/run_evaluation.sh
```

### Analyze Results

```bash
# Execution scores
python3 scripts/analyze/analyze_exec_score.py

# Code review scores
python3 scripts/analyze/analyze_cr_score.py

# Combined final scores
python3 scripts/analyze/analyze_all_score.py

# Output: results/all_score_analysis.csv
```

### Infrastructure Details

**Docker Base Image** (Ubuntu 24.04):
- Node.js 20, Python 3.12
- gcc-13, g++-13, CMake
- GitHub CLI (`gh`)
- OJ submission client

**Evaluation Pipeline** (`run_evaluation.sh`):
1. Load problem config from `config/problem_registry.json`
2. Validate API tokens
3. Launch isolated container with read-only problem/data mounts
4. Initialize Git workspace, create GitHub remote
5. Execute agent-specific script (e.g., `run_claude_code.sh`)
6. Capture submission IDs and logs
7. Autonomous OJ submission via `oj_client.py`
8. Run code review checks

**Logs**: `logs/[agent]/[model]/[problem_id]/oj_eval_*.log`

---

## 7. Multi-Agent Variant: TheBotCompany

**Paper**: "Self-Organizing Multi-Agent Systems for Continuous Software Development" (arXiv:2603.25928)

TheBotCompany is a multi-agent framework tested on ProjDevBench's hardest problems (P3, P4, P15, P16, P17).

### Architecture

- **Three-phase milestone lifecycle**: Plan → Execute → Review (persistent state machine)
- **Self-organizing teams**: Dynamic worker allocation, manager coordinates
- **Asynchronous human oversight**: Budget-aware scheduling, milestone approval gates

### Results vs. Claude Code (Single-Agent)

| Problem | TheBotCompany Tokens/Attempt | Claude Code Tokens/Attempt | Ratio |
|---------|------------------------------|----------------------------|-------|
| P3 | 1.23M | 1.62M | 0.76× |
| P4 | — | — | — |
| P15 | 0.53M | — | — |
| P16 | 0.81M | 0.15M | 5.4× |
| P17 | 3.50M | 1.09M | 3.2× |

**Average**: 1.65× more output tokens than single-agent baseline

### Token Overhead

- **Worker agents**: 70.6% of total cost
- **Manager overhead**: 29.4%
- **Per-milestone cost**: Stable across project lifetime

### Code Output Scale

| Problem | TheBotCompany LOC | Human Avg LOC | Ratio |
|---------|-------------------|---------------|-------|
| P3 | — | 1,100 | 1.48× |
| P4 | — | 1,300 | 1.30× |
| P15 | 377 | 2,094 | 0.18× |
| P17 | 3,910 | 4,204 | 0.93× |

**Interpretation**: Multi-agent produces similar-sized codebases to humans on complex problems (P17), but sometimes generates more compact solutions (P15). Token efficiency varies widely: multi-agent is more efficient on some tasks (P3) but much less on others (P16, P17).

---

## 8. Relevance for Harness Evaluation

### Can ProjDevBench Differentiate Scaffold Quality?

**Yes — empirically demonstrated.**

**Evidence**:
1. **Framework > Model**: SWE-bench Pro shows 22+ point swings from scaffold changes vs. 1 point from model swaps at the frontier
2. **Weaker model + better scaffold wins**: Confucius Code Agent (Sonnet 4.5 + custom scaffold) scored 52.7% vs. Opus 4.5 on Anthropic's scaffold at 52.0%
3. **ProjDevBench validates this**: Same model (GPT-5) scores 76.73 on Codex vs. 69.26 on Cursor — a 7.47-point gap from agent framework alone

### Published Harness Comparison Data

**None directly in ProjDevBench paper**, but strong inferential evidence:

**What ProjDevBench measures**:
- **Scaffolding decisions**: Tool selection, architecture setup, system prompt design
- **Harness orchestration**: Context engineering, tool dispatch, iterative refinement loops
- **Multi-agent coordination**: TheBotCompany results isolate multi-agent scaffolding cost

**Scaffold Components Implicitly Tested**:
1. **Tool registry & dispatch**: How agents invoke OJ submission, Git operations
2. **Context compaction**: 138 turns × 4.81M tokens requires aggressive context management
3. **Self-correction loops**: Agents must parse OJ verdicts (WA, TLE, Memory Leak) and retry
4. **Planning architecture**: Multi-file project construction demands decomposition strategy
5. **Safety & resource limits**: Submission caps (2–18) test termination logic

### Harness-Specific Insights

**From related research** (not ProjDevBench authors):
- **Scaffolding provides ~2× output quality** improvement over raw model (earezki's research)
- **Harness = runtime orchestration layer**: Tool execution, context management, safety, persistence
- **Multi-agent scaffolding trade-off**: 1.65× token overhead for distributed coordination

### Why ProjDevBench Is Ideal for Harness Eval

1. **Long-horizon tasks**: 138-turn interactions stress context engineering
2. **Resource constraints**: Time/memory limits test planning efficiency
3. **Iterative refinement**: OJ feedback loop tests self-correction architecture
4. **System-level design**: Multi-file repos test decomposition strategy
5. **Strict scoring**: 80/20 execution/review split captures both correctness and quality

**Limitation**: No explicit "harness A vs. harness B" ablation study in published results. Researchers must run custom evaluations or infer from agent framework differences.

---

## 9. Key Links

- **Paper**: https://arxiv.org/abs/2602.01655 (arXiv:2602.01655v2)
- **Repository**: https://github.com/zsworld6/projdevbench
- **TheBotCompany Paper**: https://arxiv.org/abs/2603.25928
- **ProjDevBench Homepage**: https://emergentmind.com/topics/projdevbench

### Related Tools

- **SWE-bench**: Repository-level bug fixing (ProjDevBench's predecessor)
- **HumanEval**: Function-level code generation
- **PaperBench**: ML paper replication (similar long-horizon structure)
- **Terminal-Bench**: Real-world terminal task evaluation

---

## 10. Summary

ProjDevBench fills a critical gap between toy benchmarks and production engineering by requiring agents to build complete systems from scratch under strict resource constraints. Its dual evaluation (OJ execution + LLM code review) captures both correctness and architecture quality. With 20 diverse problems, 138-turn interactions, and 4.81M tokens per task, it stresses every aspect of agent architecture: planning, tool use, context management, and iterative refinement.

**Current state**: 27.38% overall acceptance rate; agents handle basic functionality but struggle with system design, optimization, and resource management. Multi-agent approaches (TheBotCompany) show mixed results: 1.65× token overhead with comparable output quality.

**Harness evaluation potential**: Strong implicit differentiation of scaffold quality (7+ point swings from framework differences), but no published head-to-head harness ablations. Researchers evaluating Chorus or other harnesses should run custom evaluations on ProjDevBench's 20 problems to isolate harness impact from model capability.
