# SWE-bench Pro: Comprehensive Technical Guide

## 1. Overview

**SWE-bench Pro** is an enterprise-level benchmark for evaluating AI coding agents on realistic, long-horizon software engineering tasks. Created by Scale AI and released in late 2025, it succeeds the original SWE-bench and SWE-bench Verified benchmarks.

**Motivation vs. Original SWE-bench:**
- **Contamination resistance**: Built from copyleft-licensed and private commercial repositories to prevent training data overlap
- **Increased difficulty**: Multi-file patches averaging ~100+ lines of code changes, compared to simpler single-file edits
- **Enterprise realism**: Tasks requiring hours to days for professional engineers to complete
- **Language diversity**: Includes Python, JavaScript/TypeScript, Go (vs. Python-only in original)
- **Repository scale**: Large, actively maintained codebases with complex business logic

When SWE-bench Pro launched, top agents dropped from 70%+ (on SWE-bench Verified) to ~23%, highlighting the significant difficulty increase.

**Paper**: https://static.scale.com/uploads/654197dc94d34f66c0f5184e/SWEAP_Eval_Scale%20(9).pdf  
**Repository**: https://github.com/scaleapi/SWE-bench_Pro-os  
**Dataset**: https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro

---

## 2. Dataset Structure

### Splits
- **Public**: 731 tasks (openly released for evaluation)
- **Held-out**: 858 tasks (for overfitting checks, not publicly accessible)
- **Commercial**: 276 tasks (private startup repositories, results published but instances not released)

**Total**: 1,865 problem instances across 41 repositories

### Task Format (Data Fields)

Each instance is a structured record with the following fields:

| Field | Description | Size Range |
|-------|-------------|------------|
| `instance_id` | Unique identifier | 65-120 chars |
| `repo` | Repository identifier (11 classes) | string |
| `repo_language` | Python, JavaScript, TypeScript, or Go | string |
| `base_commit` | Git commit hash for base version | 40 chars |
| `patch` | Gold solution patch (diff format) | 1.44k-180k chars |
| `test_patch` | Test cases for verification | 325-322k chars |
| `problem_statement` | Issue description (similar to GitHub issue) | 419-8.04k chars |
| `requirements` | Dependencies and setup requirements | 124-6.7k chars |
| `interface` | API/interface specifications (class/function names) | 1-12.2k chars |
| `fail_to_pass` | Tests that should pass after fix | 10-155k chars |
| `pass_to_pass` | Regression tests (should remain passing) | 2-532k chars |
| `issue_specificity` | Task specificity level | 12-77 chars |
| `issue_categories` | Task type tags | string |
| `before_repo_set_cmd` | Setup commands for testing | 197-4.71k chars |
| `selected_test_files_to_run` | Test file paths | 10-10.3k chars |
| `dockerhub_tag` | Pre-built Docker image identifier | 69-128 chars |

### Loading the Dataset

```python
from datasets import load_dataset
swebench_pro = load_dataset('ScaleAI/SWE-bench_Pro', split='test')
```

---

## 3. Installation & Setup

### Prerequisites
- Python 3.8+
- Docker with sufficient resources (16GB+ RAM, 120GB+ disk space)
- Modal account (recommended) or local Docker setup

### Installation Steps

1. **Clone Repository**
```bash
git clone https://github.com/scaleapi/SWE-bench_Pro-os
cd SWE-bench_Pro-os
```

2. **Install Python Dependencies**
```bash
pip install -r requirements.txt
```

3. **Install Docker**
- macOS: Docker Desktop (allocate ≥8 CPUs, 16GB RAM, 120GB disk)
- Linux: Follow official Docker installation + post-installation steps
- Windows: Docker Desktop with WSL 2

4. **Configure Modal (Recommended)**
```bash
modal setup
# Follow prompts to generate authentication token
# Verify credentials appear in ~/.modal.toml
```

Alternative: Use local Docker with `--use_local_docker` flag (beta).

### Docker Images

Pre-built images available on Docker Hub: `jefzda/sweap-images`

Each instance's `dockerhub_tag` field specifies the correct image. Images include:
- Fully configured environments with dependencies
- Build tools and system packages
- Repository code at the base commit
- Bash shell (runs by default)

---

## 4. How to Run Evaluations

### Step 1: Generate Patches

Use your agent/scaffold to generate patches for each instance. The agent receives:
- `problem_statement`: Issue description
- Repository access at `base_commit`
- No access to `test_patch` or `fail_to_pass` tests

Output: `.pred` files containing model-generated patches.

### Step 2: Gather Patches

Consolidate predictions into JSON format:

```bash
python helper_code/gather_patches.py \
    --directory swe_bench_pro_results/your_run \
    --prefix your_model_name \
    --output predictions.json
```

**Prediction Format** (JSONL or JSON):
```json
{
  "instance_id": "repo__name-issue_number",
  "patch": "diff --git a/file.py b/file.py\n...",
  "prefix": "model_identifier"
}
```

### Step 3: Run Evaluation

```bash
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=predictions.json \
    --output_dir=evaluation_results \
    --scripts_dir=run_scripts \
    --num_workers=100 \
    --dockerhub_username=jefzda
```

Evaluation proceeds automatically:
1. Pulls Docker image for each instance
2. Applies candidate patch
3. Runs test suite
4. Compares results against gold patch behavior

### Expected Output

Results stored in `evaluation_results/`:
- `results.json`: Overall metrics
- `instance_results.jsonl`: Per-instance pass/fail details
- `run_logs/`: Execution logs for debugging

---

## 5. Evaluation Methodology

### Resolve Rate (Primary Metric)

A task is **resolved** if and only if both conditions are satisfied:

1. **Issue Resolution**: All `FAIL_TO_PASS` tests pass
   - Tests that fail on `base_commit` without any patch
   - Tests that pass after applying the gold patch
   - Agent's patch must also make these tests pass

2. **No Regressions**: All `PASS_TO_PASS` tests continue passing
   - Tests that pass on `base_commit` before any changes
   - Tests that still pass after applying the gold patch
   - Agent's patch must not break any of these

**Grading**: Binary (0% or 100% per instance). Partial credit is not awarded.

### Test Verification Process

Scale AI's human verification ensures:
- Tests run consistently (executed 3x, flaky tests filtered)
- `FAIL_TO_PASS` tests are relevant to the problem statement
- Tests are not overly broad or tangential
- Docker environments run reliably out-of-the-box

### FAIL_TO_PASS vs PASS_TO_PASS Mechanics

**FAIL_TO_PASS** tests verify the specific bug fix or feature:
- Example: `test_new_feature()` fails before the PR, passes after
- Represents the "forward progress" requirement

**PASS_TO_PASS** tests ensure existing functionality is preserved:
- Example: `test_existing_api()` passes before and after the PR
- Represents the "no breakage" constraint

Both sets must be fully satisfied for a task to count as resolved.

---

## 6. Prediction Format (JSONL Specification)

### Required Fields

```json
{
  "instance_id": "string (required)",
  "model_patch": "string (required)",
  "model_name_or_path": "string (optional)"
}
```

### Supported Formats

**List format** (JSONL):
```json
[
  {"instance_id": "django__django-12345", "model_patch": "diff ...", "model_name_or_path": "claude-opus-4.5"},
  {"instance_id": "flask__flask-6789", "model_patch": "diff ...", "model_name_or_path": "claude-opus-4.5"}
]
```

**Dictionary format**:
```json
{
  "django__django-12345": {"model_patch": "diff ...", "model_name_or_path": "claude-opus-4.5"},
  "flask__flask-6789": {"model_patch": "diff ...", "model_name_or_path": "claude-opus-4.5"}
}
```

### Patch Content Format

Standard unified diff format:
```diff
diff --git a/path/to/file.py b/path/to/file.py
index abc123..def456 100644
--- a/path/to/file.py
+++ b/path/to/file.py
@@ -10,7 +10,7 @@ def function():
-    old_line
+    new_line
```

---

## 7. Scaffold Comparison Data

**Critical Finding**: Scaffold/harness architecture has a larger impact on performance than model capability at the frontier.

### Same Model, Different Scaffolds (Claude Opus 4.5)

Published data from Augment Code's controlled comparison:

| Scaffold | Score (Public Set) | Absolute Difference |
|----------|-------------------|---------------------|
| **Auggie** | 51.80% | Baseline (top) |
| **Cursor** | 50.21% | -1.59 points |
| **Claude Code** | 49.75% | -2.05 points |
| **SWE-Agent** (Scale baseline) | 45.89% | -5.91 points |

**Performance Spread**: 5.91 percentage points (43 additional problems solved) using identical model weights.

### Additional Scaffold Comparisons

From independent evaluations on SWE-bench Pro:

| Harness | Model | Score | Notes |
|---------|-------|-------|-------|
| Confucius Code Agent | Claude Sonnet 4.5 | 52.7% | Weaker model, better scaffold |
| Anthropic Scaffold | Claude Opus 4.5 | 52.0% | Flagship model, standard scaffold |

**Conclusion**: A cheaper model (Sonnet 4.5) with optimized scaffolding outperformed the flagship model (Opus 4.5) with standard scaffolding.

### Scaffold Components That Matter

Performance differences stem from:
1. **Context retrieval**: Semantic indexing vs. text-based search
2. **Tool orchestration**: How agents navigate, edit, test
3. **Error recovery**: Retry logic and fallback strategies
4. **Memory management**: Session persistence and stale observation handling
5. **Multi-file coordination**: Dependency tracking across edits

---

## 8. Current Leaderboard (SEAL Standardized)

**SEAL (Scale's Standardized Evaluation)**: All models run with identical scaffold (250-turn limit, uncapped cost).

| Rank | Model | Score | CI (±) |
|------|-------|-------|--------|
| 1 | Claude Opus 4.5 | 45.9% | 3.60 |
| 2 | Claude Sonnet 4.5 | 43.6% | 3.60 |
| 3 | Gemini 3 Pro | 43.3% | 3.60 |
| 4 | Claude Sonnet 4 | 42.7% | 3.59 |
| 5 | GPT-5 (High) | 41.8% | 3.49 |
| 6 | GPT-5.2 Codex | 41.0% | 3.57 |
| 7 | Claude Haiku 4.5 | 39.5% | 3.55 |
| 8 | Qwen3 Coder 480B | 38.7% | 3.55 |

**Agent Systems (Custom Scaffolds)**:

| Agent | Model | Score | Scaffold Advantage |
|-------|-------|-------|-------------------|
| Claude Code | Claude Opus 4.5 | 55.4% | +9.5 pts over SEAL |
| Auggie | Claude Opus 4.5 | 51.8% | +5.9 pts over SEAL |
| Cursor | Claude Opus 4.5 | 50.2% | +4.3 pts over SEAL |

**Leaderboard URL**: https://labs.scale.com/leaderboard/swe_bench_pro_public

---

## 9. Using SWE-bench Pro for Harness A/B Testing

### Setup for Controlled Comparison

1. **Choose Baseline Scaffold**: Use Scale's SWE-Agent as control (45.89% with Opus 4.5)

2. **Implement Test Scaffold**: Develop your custom harness with:
   - Same model (e.g., Claude Opus 4.5)
   - Modified architecture (retrieval, tools, prompts)

3. **Run Both Scaffolds**:
```bash
# Baseline (SWE-Agent)
python run_swe_agent.py --model claude-opus-4.5 --output baseline_predictions.json

# Test Scaffold
python run_your_scaffold.py --model claude-opus-4.5 --output test_predictions.json
```

4. **Evaluate Identically**:
```bash
python swe_bench_pro_eval.py --patch_path=baseline_predictions.json --output_dir=baseline_results
python swe_bench_pro_eval.py --patch_path=test_predictions.json --output_dir=test_results
```

### Analysis Recommendations

- **Instance-level diff**: Identify which problems each scaffold solves uniquely
- **Failure mode analysis**: Categorize errors (retrieval failure, edit precision, test breakage)
- **Cost-performance tradeoff**: Track API tokens and latency per scaffold
- **Statistical significance**: Use confidence intervals (±3.5-3.6 points at 731 tasks)

### Key Variables to Isolate

| Variable | How to Control |
|----------|----------------|
| Model | Use identical model string and API endpoint |
| Turn limit | Set same `max_turns` parameter |
| Cost cap | Remove or set identical budget limits |
| Evaluation harness | Use Scale's official evaluation script |
| Random seed | Fix seed for reproducibility |

### Expected Sensitivity

From published data, scaffold changes can swing results by:
- **5-10 points**: Significant architectural differences (retrieval engine, tool design)
- **2-5 points**: Moderate changes (prompt engineering, retry logic)
- **<2 points**: Minor tweaks (formatting, default parameters)

---

## 10. Cost and Time Estimates

### Time Estimates

**Single Instance**:
- Fast models (GPT-5, Claude): 5-15 minutes
- Reasoning models (o3, extended thinking): 10-20 minutes

**Full Public Set (731 tasks)**:
- **Sequential (1 worker)**: 60-180 hours
- **Parallel (100 workers)**: ~5-10 hours (with Modal or cloud)

Published benchmarks from Harbor Framework:
- Local Docker (4 workers): ~50 hours, ~$600 API cost
- Daytona/Modal (50 workers): ~5 hours, ~$600 API cost + compute

### Cost Estimates

**Per-Instance API Cost** (based on reported data):

| Model | Cost per Task | Notes |
|-------|--------------|-------|
| Claude Opus 4.5 | $3.50-4.00 | High token usage, expensive output ($25/1M) |
| Claude Sonnet 4.5 | $2.00-2.50 | Balanced cost/performance |
| Claude Haiku | $0.50 | Budget option |
| GPT-5 | $1.50 | Efficient with caching |
| GPT-5.2 Codex | $1.80 | Optimized for code |
| Gemini 3 Pro | $1.00 | Most cost-effective frontier model |
| DeepSeek Coder | $0.003 | Ultra-low cost ($0.28/$0.42 per 1M tokens) |

**Full Public Set (731 tasks)**:
- **Frontier models**: $600-800 (Claude Opus 4.5)
- **Mid-tier models**: $300-500 (Sonnet, GPT-5)
- **Budget models**: $50-100 (Haiku, DeepSeek)

### Cost Optimization Strategies

1. **Prompt caching**: 90% discount on cached input tokens (Anthropic, OpenAI)
2. **Batch API**: 50% discount for non-urgent evaluations (24h turnaround)
3. **Model selection**: Use cheaper models for initial debugging, frontier models for final runs
4. **Selective evaluation**: Test on subset first (e.g., 50-100 instances) before full run
5. **Turn limits**: Cap max turns to prevent runaway token usage

### Infrastructure Costs

- **Modal compute**: Included in API costs above
- **Local Docker**: Free compute, but slower (requires powerful machine)
- **AWS/Cloud**: $50-200 for spot instances (100 parallel workers, 5-10 hours)

---

## 11. Key Links

| Resource | URL |
|----------|-----|
| **Official Repository** | https://github.com/scaleapi/SWE-bench_Pro-os |
| **Dataset (HuggingFace)** | https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro |
| **Paper (PDF)** | https://static.scale.com/uploads/654197dc94d34f66c0f5184e/SWEAP_Eval_Scale%20(9).pdf |
| **SEAL Leaderboard** | https://labs.scale.com/leaderboard/swe_bench_pro_public |
| **Docker Hub Images** | https://hub.docker.com/u/jefzda |
| **SWE-Agent Submodule** | https://github.com/princeton-nlp/SWE-agent |
| **Original SWE-bench** | https://www.swebench.com |
| **SWE-bench GitHub** | https://github.com/swe-bench/SWE-bench |

---

## Summary: Why SWE-bench Pro Matters for Harness Engineering

**Empirical Evidence**: The 5.91-point spread between SWE-Agent (45.89%) and Auggie (51.80%) using identical Claude Opus 4.5 weights represents 43 additional problems solved—purely through architectural improvements. This validates that **scaffold engineering is now the primary frontier** for advancing AI coding agents.

**Actionable Insight for Chorus**: When evaluating or improving harness design, SWE-bench Pro provides a contamination-resistant, reproducible testbed where changes can be measured with statistical confidence. Focus optimization efforts on retrieval mechanisms, tool orchestration, and error recovery—these dominate model capability differences at the frontier.
