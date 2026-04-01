# PRDBench: Comprehensive Research Report

## Overview

**PRDBench** is a benchmark for evaluating AI coding agents on complete project development from Product Requirement Documents (PRDs). Unlike traditional benchmarks that test code snippets or single-file updates, PRDBench evaluates whether agents can transform structured PRDs into functional, real-world software projects.

**Paper**: arXiv:2510.24358 (Accepted at AAMAS 2026, v3 published March 23, 2026)  
**Authors**: Lingyue Fu, Bolun Zhang, Hao Guan, Yaoming Zhu, Lin Qiu, Weiwen Liu, Xuezhi Cao, Xunliang Cai, Weinan Zhang, Yong Yu  
**Institutions**: Shanghai Jiao Tong University, Meituan, AGI-Eval  
**GitHub**: https://github.com/AGI-Eval-Official/PRDBench  
**Dataset**: AGI-Eval/PRDbench on Hugging Face  
**Paper URL**: https://arxiv.org/abs/2510.24358

## Motivation

Existing code agent benchmarks suffer from two critical limitations:

1. **High annotation cost**: Manual creation of project-level benchmarks requires domain experts spending days per task
2. **Rigid evaluation metrics**: Traditional unit tests fail to capture understanding of complex business logic, CLI interactions, or file structure requirements

PRDBench addresses both issues through an agent-driven construction pipeline and flexible, multi-modal evaluation beyond unit tests.

## Dataset Structure

### Scale and Coverage

- **50 real-world Python projects** spanning **20 distinct application domains**
- **1,258 total evaluation metrics** (originally reported as 1,262 in early versions)
  - 408-409 Unit Test metrics
  - 729-732 Shell Interaction metrics
  - 118-124 File Comparison metrics
- Average PRD length: **105.22 lines**
- Tasks sourced from real-world requirements, academic projects, and thesis work

### Domain Coverage

The benchmark spans 20 common subdomains in Python software development, including data processing, machine learning, and diverse technical sub-skills. The exact 20 domain labels are distributed to ensure balanced coverage, with at least one representative task from less common domains and multiple tasks in prevalent areas like data processing and ML that require diverse technical approaches.

### Task Format

Each task (identified as `{task_id}/`) contains:

```
{task_id}/
├── src/
│   └── PRD.md                          # Product Requirements Document
└── evaluation/
    └── detailed_test_plan.json         # Test cases and evaluation metrics
```

The PRD includes:
- Requirement Overview
- Functional Requirements
- Data Requirements
- Structured criteria scheme for QA checks

The test plan follows the **AAA (Arrange-Act-Assert)** methodology:
- **Arrange**: Set up test case with necessary files, input data, environment configurations
- **Act**: Execute core behavior (run program, perform interaction tests, obtain outputs)
- **Assert**: Verify expected outcomes by checking system response/state, determine pass/fail

## Task Generation Pipeline

PRDBench employs a five-step **agent-driven annotation pipeline** that reduces human effort to approximately **8 hours per task**:

### Step 1: PRD and Test Plan Initialization
Code agents (e.g., Claude Code) generate detailed, standardized PRD documents from seed tasks. GPT-4.1 then generates metric outlines structured using the AAA methodology.

### Step 2: Scaffold and Criteria Generation
State-of-the-art code agents generate:
- **Project scaffold**: Module design, interface design, core framework
- **Criteria scheme expansion**: Test interfaces and test artifacts based on the scaffold

The scaffold simplifies criteria generation by providing well-defined code interfaces.

### Step 3: Human Inspection
Human reviewers with standard CS background (not requiring domain experts):
- Verify interface correctness
- Ensure output alignment with PRD
- Run tests to validate the setup
- Provide feedback if mismatches are found

### Step 4: Agent-Based Fix and Refinement
Iterative improvement cycle (minimum 5 rounds required):
- Agent fixes issues based on human feedback
- Continuous refinement until all tests align with PRD specifications

### Step 5: Remove Scaffold
**Critical step**: All boilerplate code is stripped away, leaving only:
- The PRD
- The evaluation scheme
- Necessary assets

This forces agents under test to build projects **from scratch** rather than filling in blanks, creating a true zero-shot development environment.

## Evaluation Methodology

### Three Evaluation Categories

**1. Unit Tests (408 metrics)**
- pytest-based test scripts
- Verify individual components and functions
- Traditional correctness checking

**2. Shell Interaction (732 metrics)**
- Predefined shell commands with simulated user inputs
- Output comparison against expected results
- Tests CLI interfaces and program behavior

**3. File Comparison (118 metrics)**
- Compare produced artifacts against reference solutions
- Validate output files, data structures, generated content

### The EvalAgent (PRDJudge)

PRDBench uses an **Agent-as-a-Judge** paradigm powered by **PRDJudge**, a specialized evaluator fine-tuned on Qwen3-Coder-30B.

**Key Capabilities**:
- File I/O operations (read/write)
- Command-line execution
- Image processing
- Multimodal LLM interface (powered by GPT-4o) for graph analysis
- Specialized judge tool for terminal log generation
- Interactive shell capabilities

**Why Specialized Training Matters**: General-purpose LLMs hallucinate when judging complex execution logs or subtle file differences. PRDJudge's specialized training enables systematic verification strategies, avoiding redundant tool invocations and execution-heavy inefficiencies.

### Human Consistency: 81.56%

**Measurement Method**: Human Alignment Rate (HAR) - exact match accuracy between scores predicted by EvalAgent and human-annotated ground truth.

**Results from 282 distinct test cases**:
- **230 cases (81.56%)**: Perfect score alignment
- **9 cases (3.2%)**: Absolute difference of 1
- **43 cases (15.2%)**: Absolute difference of 2

**Alignment by test type**:
- File Comparison: 84.62%
- Shell Interaction: 82.55%
- Unit Test: 79.44%

**Variance**: High variance (774.66) and standard deviation (27.83%) indicate alignment varies significantly by project complexity, ranging from 0% to 100%.

### PRDJudge Performance

**Human Alignment Rate (HAR)**:
- In-domain: **91.75%**
- Out-of-domain: **92.69%**
- Surpasses massive proprietary models: GPT-5.2 (89.76%), Claude-4.5 (90.64%)

**Stability Metrics**:
- Unanimous Agreement Rate (UAR): **94.19%** (vs ~91% for general models)
- Pairwise Agreement Rate: **96.07%** across three independent runs

**Efficiency**:
- Reduced inference time and token consumption by **>50%** vs Qwen3-30B base model
- Average evaluation: 425.62 seconds, $2.68 API cost per task

## Leaderboard

Official results from the [GitHub README](https://github.com/AGI-Eval-Official/PRDBench). Two evaluation phases:
- **DEV**: Zero-shot generation from PRD (no iteration)
- **DEBUG**: Iterative refinement with test feedback

### Minimal Agents (Bare Model + Minimal Scaffold)

| Model | DEV | DEBUG | Delta |
|-------|-----|-------|-------|
| **Claude-4.5** | **69.19%** | 56.40% | -12.79% |
| GPT-5.2 | 62.49% | 69.00% | +6.51% |
| Qwen3-Coder | 43.84% | 48.29% | +4.45% |
| DeepSeek-V3.2 | 40.11% | 24.80% | -15.31% |
| GLM-4.7 | 38.39% | 35.33% | -3.06% |
| Gemini-3-Pro | 22.76% | 27.28% | +4.52% |
| Kimi-K2 | 20.52% | 36.17% | +15.65% |
| Minimax-M2 | 17.60% | 24.75% | +7.15% |

### Commercial Agents (Full Agent Framework)

| Agent | DEV | DEBUG | Delta |
|-------|-----|-------|-------|
| CodeX | 62.09% | 65.02% | +2.97% |
| **Claude Code** | 56.65% | **70.25%** | +13.60% |
| Qwen Code | 39.91% | 35.95% | -3.96% |
| Gemini CLI | 11.29% | 21.51% | +10.22% |

### Cross-Benchmark Comparison (Claude Code)

| Benchmark | Score |
|-----------|-------|
| DevAI | 73.0% |
| SWE-Bench Verified | 70.3% |
| MLE-Bench | 51.1% |
| **PRDBench** | **~45.5%** (DEV/DEBUG avg) |
| PaperBench | 21.0% |

### Key Observations

1. **Claude Code excels at DEBUG (70.25%)** but lags in DEV (56.65%) — its scaffold is strong at iterative refinement but weaker at initial planning compared to bare Claude-4.5 (69.19% DEV).

2. **Scaffold can hurt zero-shot planning**: Claude-4.5 bare scores 69.19% DEV, but Claude Code (with scaffold) scores only 56.65% DEV. Current scaffolds add overhead without improving initial architectural decisions.

3. **Debugging scaffolds matter most**: The largest DEV → DEBUG gains come from agents with strong iteration loops — Claude Code (+13.60%), Kimi-K2 (+15.65%), Gemini CLI (+10.22%).

4. **PRDBench is significantly harder** than SWE-Bench (45.5% vs 70.3% for Claude Code), validating its use for differentiating frontier agents.

5. **External adoption is still early**: Only 3 papers cite PRDBench as of April 2026. No results from Aider, OpenHands, or SWE-Agent yet — opportunity to be an early adopter.

### Implications for Chorus

The DEV/DEBUG split reveals a clear opportunity:

- **DEV phase gap**: Claude Code's scaffold hurts initial planning (56.65% vs 69.19% bare). Chorus's PM agent doing structured requirement analysis and task decomposition could close or reverse this gap.
- **DEBUG phase baseline**: Claude Code already leads at 70.25%. Chorus's verify loop and session management should maintain or improve this.
- **Target**: Chorus + CC should aim to beat both Claude-4.5 DEV (69.19%) and Claude Code DEBUG (70.25%) — demonstrating that a well-designed harness improves *both* planning and iteration.

## Comparison with ProjDevBench

PRDBench and ProjDevBench are **different benchmarks** addressing similar goals but with distinct approaches:

### ProjDevBench (arXiv:2602.01655, released February 2026)

**Scale**: 20 problems across 8 categories  
**Language**: Primarily C++  
**Input**: High-level instructions without initial codebase (project-creation setting) or partial codebase (project-completion setting)  
**Output**: Full software repositories executable in practice  
**Evaluation**: 
- Online Judge (OJ) testing for functional correctness (80% weight)
- LLM-assisted code review for compliance (20% weight)
- Build system requirements (CMake)

**Focus**: End-to-end project construction with architecture design, functional correctness, and iterative solution refinement

**Interaction**: Extended sessions averaging 138 turns and 4.81M tokens per problem

### PRDBench vs ProjDevBench

| Aspect | PRDBench | ProjDevBench |
|--------|----------|--------------|
| **Scale** | 50 tasks | 20 tasks |
| **Language** | Python | Primarily C++ |
| **Domains** | 20 Python subdomains | 8 categories (concept to real-world apps) |
| **Input** | Structured PRD (105 lines avg) | High-level instructions |
| **Evaluation Metrics** | 1,258 scoring points (Unit/Shell/File) | OJ + code review (pass/fail weighted) |
| **Judge** | PRDJudge (specialized fine-tuned agent) | OJ tests + LLM code review |
| **Annotation** | Agent-driven (8h per task) | Manual curation (expert-intensive) |
| **Scaffolding** | Generated then removed (zero-shot) | Not provided (project-creation) or partial (project-completion) |

**Complementary**: ProjDevBench targets C++ systems programming with build configurations, while PRDBench focuses on Python project delivery from business requirements.

## Harness A/B Testing Potential

### Free Development Mode

PRDBench supports two evaluation modes:

1. **Fixed Interface Mode** (default): Agents work within defined scaffolds
2. **Free Development Mode**: Only PRD provided, no fixed interfaces or scaffolding

**Results**:
- Distinction among agents decreases (variance 0.011 vs 0.028 in fixed mode)
- **Relative ranking remains stable**
- EvalAgent adapts to flexible interface designs

### Scaffold Comparison Implications

PRDBench's dual-mode capability makes it suitable for harness A/B testing:

- **Stable rankings**: Scaffold changes affect absolute scores but preserve model ordering (if capability differences are substantial)
- **Agent-driven construction**: Can generate multiple scaffold variations efficiently
- **Comprehensive metrics**: 1,258 scoring points provide granular performance measurement
- **Cost-effective**: Automated evaluation reduces per-run cost

**Limitation**: Recent research (arXiv:2603.23749 on "Efficient Benchmarking") notes that scaffold engineering has practical limits—it's difficult to boost a weaker model so dramatically that it overtakes a substantially stronger one on sufficiently challenging benchmarks. However, PRDBench's stability across modes suggests it can detect meaningful harness effects within model classes.

## Running PRDBench

### Requirements

- Python 3.10 or higher
- Conda environment manager
- API keys for evaluation models

### Setup

```bash
# Create environment
conda create -n evalADK python=3.10 -y
conda activate evalADK

# Install dependencies
pip install -r requirements.txt

# Configure API credentials
# Edit: Evaluation/adk_example/code_eval_agent/config.py
# Update line 744 in mcp_config.py with VLLM settings
```

### Running Evaluation

```bash
bash Evaluation/Evaluation_infer.sh \
  MODEL_NAME \
  ROOT_PATH \
  PORT \
  PYTHON_INTERPRETER_PORT \
  FILE_OPERATIONS_PORT \
  SYSTEM_OPERATIONS_PORT \
  source_dir
```

**Parameters**:
- `MODEL_NAME`: Model identifier for evaluation
- `ROOT_PATH`: Base directory for outputs
- Port numbers: Ensure no conflicts with existing services

**Output**: Results saved as `result_{round}.json` in workspace

### Infrastructure

- Built on Google's Agent Development Kit (ADK)
- MCP (Model Context Protocol) server implementation for tool access
- Minimal agent framework available at: https://github.com/fulingyue/Minimal-CodeAgent

## Key Contributions

1. **Agent-driven construction pipeline**: Reduces annotation cost from expert-weeks to 8 hours per task with basic CS background reviewers

2. **Comprehensive benchmark**: 50 real-world Python projects with structured PRDs, 1,258 scoring points, and flexible multi-modal evaluation

3. **Specialized evaluation agent**: PRDJudge achieves >90% human alignment, far exceeding general LLM judges

4. **Scalable framework**: Enables efficient creation of project-level benchmarks with reduced human supervision

5. **Paradigm shift**: From "coding ability" measurement to "software delivery capacity" assessment

## Citation

```bibtex
@misc{fu2025automaticallybenchmarkingllmcode,
  title={Automatically Benchmarking LLM Code Agents through Agent-Driven 
         Annotation and Evaluation},
  author={Lingyue Fu and Bolun Zhang and Hao Guan and Yaoming Zhu and 
          Lin Qiu and Weiwen Liu and Xuezhi Cao and Xunliang Cai and 
          Weinan Zhang and Yong Yu},
  year={2025},
  eprint={2510.24358},
  archivePrefix={arXiv},
  primaryClass={cs.SE}
}
```

## Resources

- **Paper**: https://arxiv.org/abs/2510.24358
- **GitHub Repository**: https://github.com/AGI-Eval-Official/PRDBench
- **Dataset**: https://huggingface.co/datasets/AGI-Eval/PRDbench
- **PRDJudge Model Weights**: Publicly available (link in paper)
- **Minimal Agent Framework**: https://github.com/fulingyue/Minimal-CodeAgent
- **License**: MIT

## Limitations and Future Directions

1. **Scale**: 50 tasks, though comprehensive, is smaller than some repository-level benchmarks
2. **Language**: Python-only; unclear if findings generalize to other languages
3. **Domain enumeration**: Specific 20 domain names not publicly detailed in paper
4. **Leaderboard**: No official public leaderboard found (as of April 2026)
5. **Evaluation cost**: $2.68 per task with PRDJudge; full benchmark run costs ~$134

## Conclusion

PRDBench represents a paradigm shift from snippet-level code generation to full project delivery evaluation. Its agent-driven construction pipeline, comprehensive multi-modal evaluation, and specialized judge (PRDJudge) provide a scalable, robust framework for assessing state-of-the-art code agents. The benchmark's focus on PRD-to-project transformation aligns with real-world software development workflows, making it particularly relevant for evaluating autonomous coding systems intended for production use.

For harness comparison, PRDBench's free development mode and stable relative rankings suggest utility for A/B testing, though the magnitude of scaffold effects may be limited by fundamental model capability differences.
