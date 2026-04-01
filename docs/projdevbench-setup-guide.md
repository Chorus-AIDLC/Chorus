# ProjDevBench Setup Guide - Complete Reference

**Repository**: https://github.com/zsworld6/projdevbench  
**Paper**: https://arxiv.org/abs/2602.01655  
**Date**: April 1, 2026

## Executive Summary

ProjDevBench is a benchmark for evaluating AI coding agents on **end-to-end project construction** (not just bug fixes). It uses:
- **20 problems** across 8 categories (data structures, interpreters, management systems, etc.)
- **Dual evaluation**: Online Judge (OJ) execution testing + LLM-based code review
- **ACMOJ** as the online judge platform (https://acm.sjtu.edu.cn/OnlineJudge)
- **Docker containers** for isolated, reproducible execution
- **Git-based workflow**: Each evaluation creates a GitHub repo tracking the agent's work

Final score = 0.8 × Execution Score + 0.2 × Code Review Score

---

## 1. Prerequisites

### Required Tools
```bash
# Check you have these installed
docker --version          # Docker Desktop or Engine
git --version             # Git
jq --version              # JSON parser (brew install jq / apt-get install jq)
python3 --version         # Python 3.8+
gh --version              # GitHub CLI (optional but recommended)
```

### Required Accounts & Tokens

#### 1.1 GitHub Personal Access Token (Fine-grained)

**Create at**: https://github.com/settings/personal-access-tokens/new

**CRITICAL PERMISSIONS** (missing these causes `createRepository` errors):
- **Administration**: Read and write (to create repos)
- **Contents**: Read and write (to push code)

**Recommendation**: Create a dedicated GitHub account for experiments to avoid cluttering your main account with evaluation repos (each evaluation creates a new public repo like `oj-eval-claude-code-001-20260401123456`).

#### 1.2 ACMOJ API Token

**Platform**: https://acm.sjtu.edu.cn/OnlineJudge

**Registration**:
- Use student ID: `123456123456` (this is the universal test account ID per their docs)
- After login, get API token at: https://acm.sjtu.edu.cn/OnlineJudge/settings/api

**What is ACMOJ?**
- ACMOJ is a **public online judge** hosted by Shanghai Jiao Tong University
- It's **NOT self-hosted** - you connect to their service via API
- Supports multiple submission types: code files, Git URLs
- Provides test case execution with detailed verdicts (Accepted, Wrong Answer, TLE, MLE, etc.)
- Free to use for academic purposes

**API Endpoint**: https://acm.sjtu.edu.cn/OnlineJudge/api/v1

#### 1.3 Agent-Specific API Keys

You need keys for the agents you want to test:

| Agent | Required Key | Get From |
|-------|--------------|----------|
| **claude-code** | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| **cursor** | `CURSOR_API_KEY` | Cursor settings |
| **gemini-cli** | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| **codex** | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| **augment** | `AUGMENT_SESSION_AUTH` | Augment settings (JSON object) |
| **copilot** | GitHub OAuth | Requires Copilot subscription |

---

## 2. Installation Steps

### 2.1 Clone Repository

```bash
git clone https://github.com/zsworld6/projdevbench.git
cd projdevbench
```

### 2.2 Configure Environment Variables

**Copy and edit the config file**:
```bash
cp config/environment.env.example config/environment.env
vim config/environment.env  # or nano, code, etc.
```

**Minimum required configuration**:
```bash
# GitHub (REQUIRED for all agents)
GITHUB_USER="your_github_username"
GITHUB_TOKEN="github_pat_xxxxxxxxxxxxx"  # Fine-grained token with Admin+Contents permissions

# ACMOJ (REQUIRED for all agents)
ACMOJ_TOKEN="your_acmoj_token"

# Claude Code (if testing Claude)
ANTHROPIC_API_KEY="sk-ant-xxxxxxxxxxxxx"
ANTHROPIC_BASE_URL="https://api.anthropic.com"  # Can use proxy or compatible endpoint

# Optional: Custom endpoints for API proxies
# OPENAI_BASE_URL="https://api.openai.com/v1"
# ANTHROPIC_BASE_URL="https://api.anthropic.com"

# Optional: Proxy configuration (if behind corporate firewall)
# https_proxy="http://host.docker.internal:7890"
# http_proxy="http://host.docker.internal:7890"
```

**Note**: The `host.docker.internal` hostname allows Docker containers to access services running on the host machine.

### 2.3 Create Logs Directory with Permissions

The evaluation runs inside Docker as user `agent`. You need to ensure the logs directory is writable:

```bash
mkdir -p logs
chmod -R 777 logs/
```

**Why**: Docker containers run as non-root user `agent` (UID different from host) and need write access to save logs.

### 2.4 Build Docker Images

ProjDevBench uses a two-stage Docker build:

**Stage 1: Base image** (installs all CLI tools)
```bash
cd docker/base
docker build -t projdevbench-base:latest .
cd ../..
```

**What's in the base image** (`docker/base/Dockerfile`):
- Ubuntu 24.04
- Node.js 20
- GCC 13, G++ 13, CMake
- Python 3.12 with `requests`
- GitHub CLI (`gh`)
- All agent CLIs: `@google/gemini-cli`, `@anthropic-ai/claude-code`, `@github/copilot`, `@openai/codex@0.91.0`, `@augmentcode/auggie`
- Cursor (installed to `~/.local/bin`)
- `iverilog` (Verilog simulator for problem 008)
- Non-root user `agent` with sudo permissions for apt

**Stage 2: Runner image** (adds problem files and scripts)
```bash
docker build -t projdevbench-runner:latest -f docker/agent-runner/Dockerfile .
```

**What the runner adds**:
- Copies `scripts/container/` (agent execution scripts)
- Copies problem definitions from `problem/` (mounted at runtime)
- Sets up entrypoint and working directories

**Build time**: ~10-15 minutes total (depends on network speed)

---

## 3. Running Evaluations

### 3.1 Interactive Mode (Recommended for First Run)

```bash
./scripts/run_all_problem.sh
```

This will:
1. Show menu to select agent (cursor, claude-code, gemini-cli, codex, augment, copilot)
2. Show menu to select model (based on agent, from `config/agent_model_config.json`)
3. Ask if you want to run specific problem range (e.g., problems 001-005)
4. Execute sequentially with detailed logs

**Example interaction**:
```
==========================================
🤖 Select Agent:
==========================================
1. augment
2. claude-code
3. codex
4. copilot
5. cursor
6. gemini-cli
==========================================
Enter agent number (1-6): 2

✅ Selected agent: claude-code

==========================================
🎯 Select Model for claude-code:
==========================================
1. glm-4.6
2. deepseek-reasoner
3. qwen3-coder-480b-a35b-instruct
4. gpt-5
5. kimi-k2-0905-preview
6. gemini-3-pro-preview
7. claude-sonnet-4-5-20250929
8. claude-haiku-4-5-20251001
9. claude-opus-4-5-20251101
==========================================
Enter model number (1-9): 7

✅ Selected model: claude-sonnet-4-5-20250929
```

### 3.2 Non-Interactive Mode (Environment Variables)

```bash
# Run all problems
AGENT=claude-code MODEL=claude-sonnet-4-5-20250929 ./scripts/run_all_problem.sh

# Run specific problems
PROBLEMS="001,002,003" AGENT=claude-code MODEL=claude-sonnet-4-5-20250929 ./scripts/run_all_problem.sh

# Run with parallel execution (4 concurrent jobs)
AGENT=cursor MODEL=gemini-3-pro CONCURRENCY=4 ./scripts/run_all_problem.sh

# Skip problems with existing logs
AGENT=codex MODEL=gpt-5 SKIP_EXISTING=true ./scripts/run_all_problem.sh

# Force re-run (ignore existing logs)
AGENT=claude-code MODEL=claude-opus-4-5-20251101 FORCE=true ./scripts/run_all_problem.sh
```

**Environment Variables**:
| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT` | Agent type | Interactive prompt |
| `MODEL` | Model name | Interactive prompt |
| `PROBLEMS` | Comma-separated list (e.g., "001,003,005") | All problems |
| `CONCURRENCY` | Number of parallel jobs | 1 (sequential) |
| `SKIP_EXISTING` | Skip if logs exist | false |
| `FORCE` | Re-run even if logs exist | false |

### 3.3 Single Problem Evaluation

```bash
# Usage: ./scripts/run_evaluation.sh <problem_id> <acmoj_problem_id> <agent> [model] [debug]

# Example: Run problem 001 with claude-code
./scripts/run_evaluation.sh 001 1000 claude-code claude-sonnet-4-5-20250929

# Debug mode (drops you into bash inside container)
./scripts/run_evaluation.sh 001 1000 claude-code claude-sonnet-4-5-20250929 debug
```

**Debug mode is very useful** for:
- Testing your environment setup
- Manually running agent commands
- Inspecting problem files
- Testing submission to ACMOJ

Inside debug mode:
```bash
# Check environment
env | grep -E '(PROBLEM|GITHUB_USER|MODEL|TIMESTAMP)' | grep -v -E '(TOKEN|KEY)'

# Explore problem files
ls -la /problems/001
cat /problems/001/README.md

# Manually run the agent
/scripts/run_agent_base.sh    # Setup (creates repo, copies files)
/scripts/run_claude_code.sh   # Run agent
```

---

## 4. Evaluation Workflow (What Happens Under the Hood)

### 4.1 Container Initialization

When you run an evaluation, the script:

1. **Generates timestamp**: `TIMESTAMP=$(date +%Y%m%d%H%M%S)` (e.g., `20260401143022`)
2. **Creates container name**: `eval-${AGENT}-${PROBLEM_ID}-${TIMESTAMP}`
3. **Mounts volumes**:
   - `/problems/${PROBLEM_ID}` ← `problem/${PROBLEM_ID}` (read-only)
   - `/workspace/logs` ← `logs/${AGENT}/${MODEL}/${PROBLEM_ID}` (writable)
   - `/data_readonly/${PROBLEM_ID}` ← `data/${PROBLEM_ID}` (read-only test data)
   - `/scripts` ← `scripts/container` (read-only)
4. **Passes environment variables**: `GITHUB_TOKEN`, `ACMOJ_TOKEN`, `ANTHROPIC_API_KEY`, etc.
5. **Sets resource limits**: 8GB RAM, 4 CPUs (configurable via `AGENT_MEMORY_LIMIT`, `AGENT_CPU_LIMIT`)

### 4.2 Agent Execution Workflow

Inside the container, `run_agent_base.sh` runs first:

**Setup Phase** (`/scripts/run_agent_base.sh`):
```bash
1. Copy problem files from /problems/${PROBLEM_ID} to /workspace/problem_${PROBLEM_ID}
2. Initialize git repository (git init)
3. Create initial commit
4. Create remote GitHub repository via `gh repo create`
5. Configure git remote URL with token auth
6. Copy test data from /data_readonly to /workspace/data
```

**Agent Phase** (e.g., `/scripts/run_claude_code.sh` for Claude):
```bash
1. Configure agent-specific settings (~/.claude/settings.json)
2. Read problem README.md and construct agent prompt
3. Launch agent with full autonomy:
   - Agent can modify any file in /workspace/problem_${PROBLEM_ID}
   - Agent can commit and push to GitHub
   - Agent can submit to ACMOJ via acmoj_client.py
   - Agent can query submission status
   - Agent can abort pending submissions (doesn't count toward limit)
4. Log all output to /workspace/logs/oj_eval_${AGENT}_${MODEL}_${PROBLEM_ID}_${TIMESTAMP}.log
5. Track submission IDs to /workspace/submission_ids.log
```

**Key Agent Prompt Elements**:
- Maximum submission limit (e.g., 2-12 depending on problem)
- Submissions exceeding limit are invalid and penalized
- Each problem has weighted test cases (weights not disclosed)
- Score = highest score among all valid submissions
- Agent must use git to track all changes
- Agent must verify push success before submitting to OJ
- Aborted submissions don't count toward limit

### 4.3 ACMOJ Submission Process

Agents use `problem/${PROBLEM_ID}/submit_acmoj/acmoj_client.py`:

**Submit Git URL**:
```bash
python3 acmoj_client.py --token $ACMOJ_TOKEN submit \
  --problem-id 1000 \
  --git-url https://github.com/user/repo.git
```

Returns:
```json
{
  "id": 123456,
  "status": "pending",
  "problem_id": 1000,
  "language": "git",
  "code": "https://github.com/user/repo.git"
}
```

**Query Status**:
```bash
python3 acmoj_client.py --token $ACMOJ_TOKEN status --submission-id 123456
```

Returns detailed verdict:
```json
{
  "id": 123456,
  "status": "accepted",  // or "wrong_answer", "time_limit_exceeded", etc.
  "score": 100.0,
  "test_cases": [
    {"id": 1, "status": "accepted", "time": 12, "memory": 2048, "score": 10.0},
    {"id": 2, "status": "accepted", "time": 15, "memory": 2100, "score": 10.0}
  ],
  "compile_log": "..."
}
```

**Abort Submission** (if stuck in pending):
```bash
python3 acmoj_client.py --token $ACMOJ_TOKEN abort --submission-id 123456
```

**Important**: Aborted submissions don't count toward the submission limit!

### 4.4 OJ Compilation Process

For Git submissions, ACMOJ does:
```bash
git clone <repo_url> . --depth 1 --recurse-submodules --shallow-submodules --no-local
cmake .         # If CMakeLists.txt exists
make            # If Makefile exists
./code < input  # Run the compiled binary
```

**Requirements**:
- Final executable must be named `code` in repo root
- Must create `.gitignore` to exclude `CMakeFiles/` and `CMakeCache.txt`
- Language: Most problems require C/C++, some accept Python

---

## 5. Log Files & Output

### 5.1 Evaluation Logs

**Location**: `logs/${AGENT}/${MODEL}/${PROBLEM_ID}/`

**Files**:
- `oj_eval_${AGENT}_${MODEL}_${PROBLEM_ID}_${TIMESTAMP}.log` - Full evaluation log
- `submission_ids_${PROBLEM_ID}_${TIMESTAMP}.log` - Submission ID tracking (JSON lines)

**Example log structure**:
```
logs/
├── claude-code/
│   └── claude-sonnet-4-5-20250929/
│       ├── 001/
│       │   ├── oj_eval_claude-code_claude-sonnet-4-5-20250929_001_20260401143022.log
│       │   └── submission_ids_001_20260401143022.log
│       └── 002/
│           └── ...
└── cursor/
    └── gemini-3-pro/
        └── ...
```

**Submission ID log format** (JSON lines):
```json
{"timestamp": "2026-04-01 14:35:12", "submission_id": 123456}
{"timestamp": "2026-04-01 14:42:05", "submission_id": 123457}
```

### 5.2 GitHub Repositories

Each evaluation creates a public GitHub repository:
- **Name**: `oj-eval-${AGENT}-${PROBLEM_ID}-${TIMESTAMP}`
- **Example**: `oj-eval-claude-code-001-20260401143022`
- **URL**: `https://github.com/${GITHUB_USER}/oj-eval-claude-code-001-20260401143022`

The repo contains:
- Complete git history of agent's work
- All code modifications
- Commit messages explaining each change
- Final solution that was submitted to OJ

---

## 6. Analysis & Scoring

### 6.1 Execution Score Analysis

```bash
# Must have ACMOJ_TOKEN in config/environment.env
python3 scripts/analyze/analyze_exec_score.py
```

**What it does**:
1. Scans `logs/` directory for all submission IDs
2. Calls ACMOJ API to get detailed results for each submission
3. Filters out submissions exceeding `max_submissions` limit (from `config/problem_registry.json`)
4. Calculates weighted score: `final_score = Σ(score/full_score × weight) / total_weight × 100`
5. Takes **highest score** among valid submissions per problem

**Output files** (in `results/`):
- `exec_results.json` - Raw submission data
- `exec_results.csv` - Raw submission data (CSV)
- `exec_score_analysis.json` - Score analysis (weighted)
- `exec_score_analysis.csv` - Score matrix
- `exec_score_summary.txt` - Human-readable summary

### 6.2 Code Review Score Analysis

```bash
# Run code review first (separate process)
./scripts/cr/run_all_cr.sh

# Then analyze CR results
python3 scripts/analyze/analyze_cr_score.py
```

**Output files** (in `results/`):
- `cr_score_analysis.json`
- `cr_score_analysis.csv`
- `cr_score_detail.csv`
- `cr_score_summary.txt`

### 6.3 Combined Score Analysis

```bash
# Default: 0.8 × Exec + 0.2 × CR
python3 scripts/analyze/analyze_all_score.py

# Custom weights
python3 scripts/analyze/analyze_all_score.py --exec-weight 0.7 --cr-weight 0.3
```

**Output files** (in `results/`):
- `all_score_analysis.json`
- `all_score_analysis.csv`
- `all_score_detail.csv`
- `all_score_summary.txt`

---

## 7. Adding Custom Agents (Claude Code + Chorus Harness)

To add a new agent (e.g., Claude Code with Chorus harness integration):

### 7.1 Create Agent Execution Script

Create `scripts/container/run_chorus_agent.sh`:

```bash
#!/bin/bash
echo "🚀 Starting Chorus-Enhanced Claude Code Agent"

# Setup function (same as other agents)
cleanup() {
    echo "📊 Collecting evaluation results..."
    if [ -f "/workspace/submission_ids.log" ]; then
        SUBMISSION_LOG_DEST="/workspace/logs/submission_ids_${PROBLEM_ID}_${TIMESTAMP}.log"
        cp /workspace/submission_ids.log "$SUBMISSION_LOG_DEST"
        cat /workspace/submission_ids.log
    fi
}
trap cleanup EXIT

# Standard environment variable checks
: "${TIMESTAMP?Required: TIMESTAMP}"
: "${PROBLEM_ID?Required: PROBLEM_ID}"
: "${ACMOJ_PROBLEM_ID?Required: ACMOJ_PROBLEM_ID}"
: "${GITHUB_TOKEN?Required: GITHUB_TOKEN}"
: "${ACMOJ_TOKEN?Required: ACMOJ_TOKEN}"
: "${ANTHROPIC_API_KEY?Required: ANTHROPIC_API_KEY}"
: "${MAX_SUBMISSIONS?Required: MAX_SUBMISSIONS}"
: "${MODEL_NAME?Required: MODEL_NAME}"
: "${CHORUS_API_KEY?Required: CHORUS_API_KEY}"  # New: Chorus authentication

# Setup logging
LOG_DIR="/workspace/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/oj_eval_chorus_${MODEL_NAME}_${PROBLEM_ID}_${TIMESTAMP}.log"
exec > >(tee -a "$LOG_FILE")
exec 2>&1

# Run base setup (git repo creation, file copying)
echo "🚀 Running base setup script"
/scripts/run_agent_base.sh

# Configure Chorus
REPO_NAME="oj-eval-chorus-${PROBLEM_ID}-${TIMESTAMP}"
WORKSPACE_DIR="/workspace/problem_${PROBLEM_ID}"
REPO_URL="https://github.com/${GITHUB_USER}/${REPO_NAME}"
cd "$WORKSPACE_DIR"

# Set up Chorus CLI configuration
mkdir -p ~/.chorus
cat <<EOT > ~/.chorus/config.json
{
  "apiUrl": "https://your-chorus-instance.com/api",
  "apiKey": "${CHORUS_API_KEY}",
  "projectUuid": "${CHORUS_PROJECT_UUID}"
}
EOT

# Create Chorus task from problem specification
echo "📋 Creating Chorus task for Problem ${PROBLEM_ID}"
TASK_DESCRIPTION=$(cat README.md)
TASK_UUID=$(chorus create-task \
  --title "ProjDevBench Problem ${PROBLEM_ID}" \
  --description "$TASK_DESCRIPTION" \
  --max-submissions "${MAX_SUBMISSIONS}" \
  --output json | jq -r '.uuid')

echo "✅ Chorus task created: ${TASK_UUID}"

# Configure Claude Code with Chorus plugin
cat <<EOT > ~/.claude/settings.json
{
  "env": {
    "ANTHROPIC_DEFAULT_MODEL": "${MODEL_NAME}",
    "CHORUS_ENABLED": "true",
    "CHORUS_TASK_UUID": "${TASK_UUID}"
  },
  "plugins": {
    "chorus": {
      "enabled": true,
      "autoCheckin": true,
      "reportProgress": true
    }
  }
}
EOT

# Construct agent prompt with Chorus integration
PROMPT="You are working with the Chorus harness for structured task execution.

## Environment
- Repository: ${REPO_URL}
- Working Directory: $(pwd)
- Problem ID: ${PROBLEM_ID} (ACMOJ: ${ACMOJ_PROBLEM_ID})
- Max Submissions: ${MAX_SUBMISSIONS}
- Chorus Task UUID: ${TASK_UUID}

## Chorus Integration
1. Check in to the task at start: \`chorus checkin ${TASK_UUID}\`
2. Report progress periodically: \`chorus report-work --task ${TASK_UUID} --message \"...\"\`
3. Submit results: \`chorus submit-for-verify --task ${TASK_UUID} --summary \"...\"\`

## ACMOJ Submission
Use \`submit_acmoj/acmoj_client.py\` to submit and query results.

## Task
Read README.md, implement solution, test locally, push to Git, submit to ACMOJ.
Track all work via Chorus. Aim for highest score within ${MAX_SUBMISSIONS} attempts.

Begin!"

echo "========================================="
echo "Chorus-Enhanced Agent Prompt:"
echo "$PROMPT"
echo "========================================="

# Run Claude Code with Chorus harness
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL}" \
ANTHROPIC_MODEL="${MODEL_NAME}" \
CHORUS_API_KEY="${CHORUS_API_KEY}" \
CHORUS_TASK_UUID="${TASK_UUID}" \
claude -p "${PROMPT}" \
  --model "${MODEL_NAME}" \
  --output-format stream-json \
  --dangerously-skip-permissions \
  --verbose

echo "========================================="
echo "🎯 Chorus-enhanced agent session completed"
echo "Repository: ${REPO_URL}"
echo "Chorus Task: ${TASK_UUID}"
echo "========================================="
```

### 7.2 Update Main Evaluation Script

Edit `scripts/run_evaluation.sh`, add case branch:

```bash
chorus|"Chorus Agent")
  echo "🎼 Running Chorus-Enhanced Claude Code Agent..."
  docker run --rm \
    "${DOCKER_MOUNT_ARGS[@]}" \
    "${DOCKER_ENV_ARGS[@]}" \
    -e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}" \
    -e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" \
    -e "CHORUS_API_KEY=${CHORUS_API_KEY}" \
    -e "CHORUS_PROJECT_UUID=${CHORUS_PROJECT_UUID}" \
    --entrypoint /bin/bash \
    prlu/ojbench-agent-runner:latest \
    -c "bash /scripts/run_chorus_agent.sh"
  ;;
```

### 7.3 Update Agent Model Config

Edit `config/agent_model_config.json`:

```json
{
  "agents": {
    "chorus": {
      "models": [
        {
          "display_name": "claude-sonnet-4.5-chorus",
          "actual_name": "claude-sonnet-4-5-20250929"
        },
        {
          "display_name": "claude-opus-4.5-chorus",
          "actual_name": "claude-opus-4-5-20251101"
        }
      ]
    }
  }
}
```

### 7.4 Install Chorus CLI in Docker Base Image

Edit `docker/base/Dockerfile`:

```dockerfile
# Add after other CLI installations
RUN npm install -g @chorus/cli@latest

# Verify
RUN chorus --version
```

### 7.5 Rebuild Docker Images

```bash
cd docker/base && docker build -t projdevbench-base:latest . && cd ../..
docker build -t projdevbench-runner:latest -f docker/agent-runner/Dockerfile .
```

### 7.6 Run Evaluation

```bash
AGENT=chorus MODEL=claude-sonnet-4.5-chorus \
CHORUS_API_KEY="your_key" \
CHORUS_PROJECT_UUID="your_project_uuid" \
./scripts/run_all_problem.sh
```

---

## 8. Problem Structure

### 8.1 Problem Directory Layout

```
problem/001/
├── README.md                    # Problem description, requirements, constraints
├── CMakeLists.txt               # CMake template (can be modified by agent)
└── submit_acmoj/
    ├── acmoj_client.py          # Python client for ACMOJ API
    └── EVALUATION_GUIDE.md      # Submission instructions, verdict explanations
```

### 8.2 Test Data Location

Test data is in `data/${PROBLEM_ID}/` and mounted read-only to `/workspace/data/${PROBLEM_ID}` inside containers.

**Note**: Not all problems have test data in the repo (some only exist on ACMOJ servers).

**Available local test data**:
```
data/
├── 002/    # int2048 test cases
├── 003/    # ICPC Management System test data
├── 004/    # Bookstore test data
├── 005/    # QOI codec samples
├── 006/    # Minesweeper test cases
├── 007/    # BASIC interpreter tests
├── 017/    # Train Ticket System test data
└── 019/    # GPU Memory Optimization test cases
```

### 8.3 Problem Registry (`config/problem_registry.json`)

Defines metadata for each problem:

```json
{
  "problems": {
    "001": {
      "name": "A+B Problem",
      "acmoj_id": "1000",              // Single ACMOJ problem
      "max_submissions": 2,            // Submission limit
      "submit_language": "git-url",
      "description": "Basic addition problem",
      "score_weight": {"1000": 100},   // Scoring weight
      "score_full": {"1000": 100.0}    // Full score
    },
    "002": {
      "name": "int2048 - Big Integer Arithmetic",
      "acmoj_id": "2014,2015,2016,2017,2018,2019",  // Multiple ACMOJ problems
      "max_submissions": 12,           // Shared limit across all 6 problems
      "submit_language": "cpp",
      "score_weight": {
        "2014": 10,
        "2015": 10,
        "2016": 10,
        "2017": 15,
        "2018": 15,
        "2019": 20
      },
      "score_full": {
        "2014": 5.0,
        "2015": 20.0,
        "2016": 16.0,
        "2017": 5.0,
        "2018": 5.0,
        "2019": 19.0
      }
    }
  }
}
```

**Key points**:
- `acmoj_id` can be single or comma-separated (multiple related problems)
- `max_submissions` is SHARED across all problems in multi-problem cases
- Weights determine relative importance of each problem/test case
- Full scores are the maximum points achievable per problem

---

## 9. Common Issues & Solutions

### 9.1 GitHub Token Permission Errors

**Error**:
```
Resource not accessible by personal access token (createRepository)
```

**Solution**: Token must have **Administration** and **Contents** permissions (Read and write). Classic tokens don't work - use Fine-grained tokens.

### 9.2 Log Directory Permission Denied

**Error**:
```
Permission denied: /workspace/logs/oj_eval_...
```

**Solution**:
```bash
chmod -R 777 logs/
```

Container runs as user `agent` (different UID) and needs write access.

### 9.3 ACMOJ Submission Stuck in Pending

**Issue**: Submission shows `"status": "pending"` for more than 2-3 minutes.

**Solution**: Abort it (doesn't count toward limit):
```bash
python3 acmoj_client.py --token $ACMOJ_TOKEN abort --submission-id 123456
```

Then resubmit.

### 9.4 Git Clone Fails on ACMOJ (Network Error)

**Error** (in OJ verdict):
```
fatal: unable to access 'https://github.com/...' : Failed to connect to github.com port 443
```

**Cause**: ACMOJ servers sometimes have connectivity issues to GitHub.

**Solution**: Wait a few minutes and resubmit. Or use SSH URL instead of HTTPS:
```python
git_url = "git@github.com:user/repo.git"  # Instead of https://
```

### 9.5 Docker Build Fails - Node.js or Package Issues

**Solution**: Check Docker build logs. Common fixes:
- Update base image: `FROM ubuntu:24.04`
- Pin package versions: `npm install -g @anthropic-ai/claude-code@1.11.0`
- Clear Docker cache: `docker builder prune -a`

### 9.6 Agent Exceeds Submission Limit

**Issue**: Agent submits more than `max_submissions` times.

**Impact**: Extra submissions are filtered out during analysis and incur score penalty.

**Prevention**: Agent prompt clearly states limit. For custom agents, add submission counter logic.

---

## 10. Advanced Configuration

### 10.1 Custom ACMOJ Endpoint

If using a self-hosted OJ compatible with ACMOJ API:

Edit `config/environment.env`:
```bash
OJ_API_ENDPOINT="http://your-oj-instance.com/api"
```

Edit `problem/${PROBLEM_ID}/submit_acmoj/acmoj_client.py`:
```python
self.api_base = os.environ.get("OJ_API_ENDPOINT", "https://acm.sjtu.edu.cn/OnlineJudge/api/v1")
```

### 10.2 Using API Proxies or Compatible Endpoints

For Claude Code via compatible APIs (DeepSeek, OpenRouter, etc.):

```bash
# config/environment.env
ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
ANTHROPIC_API_KEY="your_deepseek_api_key"
```

For Codex via OpenRouter:
```bash
CODEX_BASE_URL="https://openrouter.ai/api/v1"
CODEX_API_KEY="sk-or-xxxxxxxxxxxxx"
```

### 10.3 Parallel Execution Tuning

Control concurrency based on your machine:

```bash
# High-end machine (16+ cores, 32+ GB RAM)
CONCURRENCY=8 AGENT=cursor MODEL=auto ./scripts/run_all_problem.sh

# Mid-range machine (8 cores, 16 GB RAM)
CONCURRENCY=4 AGENT=claude-code MODEL=sonnet-4.5 ./scripts/run_all_problem.sh

# Low-end machine (4 cores, 8 GB RAM)
CONCURRENCY=2 AGENT=codex MODEL=gpt-5 ./scripts/run_all_problem.sh
```

**Note**: Each container uses up to 8GB RAM and 4 CPUs by default (configurable via `AGENT_MEMORY_LIMIT`, `AGENT_CPU_LIMIT`).

### 10.4 Custom Resource Limits

Edit `config/environment.env`:
```bash
AGENT_MEMORY_LIMIT="16g"  # Default: 8g
AGENT_CPU_LIMIT="8"       # Default: 4
```

Useful for problems requiring more memory (e.g., problem 013 STLite Map, problem 017 Train Ticket System).

---

## 11. Understanding the Problems

### 11.1 Problem Difficulty

**Easy (E)**: Project-completion setting
- Partial codebase provided (e.g., starter template)
- Agent fills in missing functionality
- Examples: 001 A+B, 002 int2048, 005 QOI, 007 BASIC Interpreter

**Hard (H)**: Project-creation setting
- Start from scratch (README + empty workspace)
- Agent designs architecture and implements everything
- Examples: 003 ICPC Management, 004 Bookstore, 015 File Storage

### 11.2 Problem Categories

| Category | Problems | Key Challenges |
|----------|----------|----------------|
| **Data Structures** | 009-013 | C++ templates, iterators, memory management, STL compatibility |
| **Management Systems** | 003, 004, 017 | Business logic, complex queries, file I/O, transaction handling |
| **Interpreters** | 007, 014, 018 | Parsing, AST, scoping, closures, evaluation semantics |
| **Storage Systems** | 015, 016 | B+ tree, disk-based paging, index management |
| **Algorithm** | 001, 002 | Precision (big integers), edge cases |
| **Assembly** | 008 | Low-level computation, instruction set implementation |
| **Game/Simulation** | 006 | State machines, UI, game logic |
| **Optimization** | 019, 020 | Memory allocation algorithms, efficiency |

### 11.3 Scoring Examples

**Problem 001 (A+B)**:
- 1 ACMOJ problem (1000)
- Max 2 submissions
- Simple: Pass all test cases = 100 points

**Problem 002 (int2048)**:
- 6 ACMOJ problems (2014-2019)
- Max 12 submissions (shared across all 6)
- Weighted scoring:
  - 2014 (weight 10): Basic operations
  - 2015 (weight 10): Addition/subtraction
  - 2016 (weight 10): Multiplication
  - 2017 (weight 15): Division
  - 2018 (weight 15): Comparison
  - 2019 (weight 20): Advanced operations
- Final score = (Σ individual_scores × weights) / total_weight × 100

**Problem 006 (Minesweeper Advanced)**:
- Special scoring: Linear interpolation based on performance score
- Baselines:
  - < 39625: 0%
  - 39625 → 100449: 0% → 28.57% (linear)
  - 100449 → 136481: 28.57% → 85.71% (linear)
  - > 136481: 100%

---

## 12. Evaluation Best Practices

### 12.1 First Run Recommendations

1. **Test with problem 001** (simplest):
   ```bash
   PROBLEMS="001" AGENT=claude-code MODEL=claude-haiku-4-5 ./scripts/run_all_problem.sh
   ```

2. **Use debug mode** to understand the workflow:
   ```bash
   ./scripts/run_evaluation.sh 001 1000 claude-code claude-haiku-4-5 debug
   ```

3. **Check logs** after completion:
   ```bash
   cat logs/claude-code/claude-haiku-4-5/001/*.log
   ```

4. **Verify GitHub repo** was created:
   - Visit https://github.com/${GITHUB_USER}?tab=repositories
   - Check for `oj-eval-claude-code-001-*` repo

5. **Run execution score analysis**:
   ```bash
   python3 scripts/analyze/analyze_exec_score.py
   cat results/exec_score_summary.txt
   ```

### 12.2 Running Full Benchmark

For comprehensive evaluation:

```bash
# Phase 1: Run all problems (can take 24-48 hours for 20 problems × full workflow)
AGENT=claude-code MODEL=claude-sonnet-4-5-20250929 \
CONCURRENCY=4 \
./scripts/run_all_problem.sh

# Phase 2: Analyze execution scores
python3 scripts/analyze/analyze_exec_score.py

# Phase 3: Run code review (requires separate setup)
./scripts/cr/run_all_cr.sh

# Phase 4: Analyze CR scores
python3 scripts/analyze/analyze_cr_score.py

# Phase 5: Calculate combined scores
python3 scripts/analyze/analyze_all_score.py

# Phase 6: Review results
cat results/all_score_summary.txt
```

### 12.3 Reproducibility Tips

- **Pin model versions** in `config/agent_model_config.json`
- **Save logs** with timestamps for each run
- **Record environment**: Docker image versions, agent CLI versions
- **Document config**: Which API endpoints, resource limits used
- **Track GitHub repos**: Don't delete them (they're part of evaluation history)

---

## 13. Comparing with Other Benchmarks

| Benchmark | Task Type | Evaluation | Scale | Difficulty |
|-----------|-----------|------------|-------|------------|
| **ProjDevBench** | End-to-end project construction | OJ + LLM review | 20 problems | High (avg 138 turns, 4.8M tokens) |
| **SWE-bench** | Issue-level bug fixing | Unit tests | 2,294 issues | Medium-High |
| **HumanEval** | Function implementation | Unit tests | 164 problems | Low-Medium |
| **APPS** | Algorithmic problems | I/O matching | 10,000 problems | Medium |
| **CodeContests** | Competitive programming | OJ verdicts | 13,000+ problems | High |

**ProjDevBench uniqueness**:
- Requires **full project construction** (not just editing existing code)
- Tests **git workflow** and **repository management**
- Uses **real online judge** with execution-based testing
- Includes **LLM-based code review** for spec compliance
- Long-horizon tasks (avg 138 turns) vs. single-shot problems

---

## 14. Key Takeaways for Claude Code + Chorus Integration

### 14.1 What ProjDevBench Tests

1. **Project planning**: Breaking down high-level spec into implementable tasks
2. **Architecture design**: Choosing data structures, file organization
3. **Iterative development**: Code → test → debug → refine cycle
4. **Git discipline**: Meaningful commits, push verification
5. **OJ interaction**: Submit → query → interpret verdict → fix
6. **Resource constraints**: Time limits, memory limits, submission limits
7. **Edge case handling**: Dealing with various test case failures

### 14.2 How Chorus Can Help

**Strengths Chorus brings**:
- **Task decomposition**: Break problem into subtasks (e.g., "implement addition", "implement multiplication")
- **Progress tracking**: Report work at each subtask completion
- **Submission management**: Count submissions, prevent exceeding limit
- **Error analysis**: Structure understanding of OJ verdicts (WA, TLE, MLE, etc.)
- **Verification workflow**: Explicit review before final submission

**Potential integration points**:
1. **Pre-evaluation**: Parse problem README → create Chorus task with acceptance criteria
2. **During evaluation**: Agent reports progress via Chorus API at key milestones
3. **Post-evaluation**: Chorus captures submission history, verdict analysis
4. **Multi-problem problems**: Chorus manages shared submission quota across problem IDs

### 14.3 Metrics to Track

For evaluating Chorus harness effectiveness:

**Efficiency metrics**:
- Submissions used vs. limit
- Time to first correct submission
- Number of iterations per problem

**Quality metrics**:
- Final OJ score (execution score)
- Code review score
- Git commit quality (via LLM analysis)

**Process metrics**:
- Task decomposition granularity
- Progress report frequency
- Error recovery success rate

---

## 15. Quick Reference

### Essential Commands

```bash
# Build Docker images
cd docker/base && docker build -t projdevbench-base:latest .
cd ../.. && docker build -t projdevbench-runner:latest -f docker/agent-runner/Dockerfile .

# Run single problem
./scripts/run_evaluation.sh 001 1000 claude-code claude-sonnet-4-5-20250929

# Run all problems (interactive)
./scripts/run_all_problem.sh

# Run with environment variables
AGENT=claude-code MODEL=claude-sonnet-4-5-20250929 PROBLEMS="001,002,003" ./scripts/run_all_problem.sh

# Debug mode
./scripts/run_evaluation.sh 001 1000 claude-code claude-sonnet-4-5-20250929 debug

# Analyze results
python3 scripts/analyze/analyze_exec_score.py
python3 scripts/analyze/analyze_all_score.py
```

### Essential Files

| File | Purpose |
|------|---------|
| `config/environment.env` | API keys and configuration |
| `config/agent_model_config.json` | Agent and model definitions |
| `config/problem_registry.json` | Problem metadata and scoring |
| `scripts/run_evaluation.sh` | Single problem evaluation |
| `scripts/run_all_problem.sh` | Batch evaluation runner |
| `scripts/container/run_claude_code.sh` | Claude Code agent script |
| `problem/${ID}/README.md` | Problem specification |
| `problem/${ID}/submit_acmoj/acmoj_client.py` | ACMOJ submission client |

### Essential Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GITHUB_TOKEN` | Yes | Create repos and push code |
| `GITHUB_USER` | Yes | GitHub username |
| `ACMOJ_TOKEN` | Yes | Submit to online judge |
| `ANTHROPIC_API_KEY` | For Claude | Claude API access |
| `ANTHROPIC_BASE_URL` | Optional | Custom API endpoint |

---

## 16. Additional Resources

- **Paper**: https://arxiv.org/abs/2602.01655
- **Homepage**: https://zsworld6.github.io/projdevbenchpage/
- **GitHub**: https://github.com/zsworld6/projdevbench
- **ACMOJ**: https://acm.sjtu.edu.cn/OnlineJudge
- **ACMOJ API Docs**: Check EVALUATION_GUIDE.md in each problem directory

---

## Summary

ProjDevBench is a comprehensive benchmark for end-to-end AI coding agents. To use it with Claude Code + Chorus:

1. **Setup**: Get GitHub token (Fine-grained, Admin+Contents), ACMOJ token, Claude API key
2. **Build**: Docker base + runner images (~15 min)
3. **Configure**: Edit `config/environment.env` and `config/agent_model_config.json`
4. **Run**: `./scripts/run_all_problem.sh` or via environment variables
5. **Analyze**: `analyze_exec_score.py` → results in `results/` directory
6. **Extend**: Add custom agent scripts, integrate Chorus harness APIs

**Key insights**:
- ACMOJ is a public online judge (not self-hosted)
- Each evaluation creates a GitHub repo and logs to `logs/`
- Submission limits are enforced; aborted submissions don't count
- Scoring is weighted and takes highest score among valid submissions
- Docker provides reproducible, isolated execution environment

For Chorus integration, focus on task management, progress tracking, and submission quota management as value-adds over vanilla Claude Code.
