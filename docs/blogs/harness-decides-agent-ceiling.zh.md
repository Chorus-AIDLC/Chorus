# Harness 决定 Agent 上限：从代码执行到项目迭代

> 同一个模型，不同的 Harness，SWE-bench 上差了 17 题。当模型能力趋于同质化，真正决定 AI Agent 表现上限的，不是它有多聪明，而是它被放在什么样的环境里工作。

## TL;DR

2026 年，AI 工程领域达成了一个共识：**Harness 比模型重要**。Claude Code、Codex、Cursor 已经为 agent 构建了成熟的代码执行 harness。但当 agent 从"写一个函数"升级到"做一个项目"，它还缺一层东西——一个覆盖从想法细化到任务验收的**项目管理 harness**。

这篇文章聊两件事：为什么 harness 已经成为 agent 表现的决定性因素，以及 Chorus(https://github.com/Chorus-AIDLC/Chorus) 在这个方向上的实践——如何让 agent 拥有完整的迭代环境，而不只是一个代码编辑器。

---

## 一、Harness Engineering：行业共识是怎么形成的

### 1.1 同一个模型，差了 17 题

2026 年初，一组 SWE-bench Verified 的评测数据引起了广泛讨论：Augment、Cursor、Claude Code 三个产品，都跑的 Claude Opus 4.5，731 道题，成绩差了 17 题。

模型完全一样。差异来自哪里？**Harness**——包裹在模型外面的那层系统：工具定义、上下文管理、错误恢复、验证循环、子任务编排。

这不是个例。整个行业都在讲同一个故事：模型是 CPU，Harness 是操作系统。没有操作系统，CPU 再快也只是一块芯片。

### 1.2 从 Prompt 到 Context 到 Harness：三次范式转移

| 阶段 | 时间 | 核心问题 |
|------|------|----------|
| Prompt Engineering | 2022–2024 | 怎么写好一条指令 |
| Context Engineering | 2025 | 怎么策展所有相关信息（RAG、Memory、工具描述） |
| Harness Engineering | 2026 | 怎么设计环境、约束和反馈循环 |

Mitchell Hashimoto（HashiCorp 创始人）在 2026 年 2 月首次明确了"Harness Engineering"这个概念：

> "Every time the agent makes a mistake, don't just hope it does better next time. Engineer the environment so it can't make that specific mistake the same way again."
>
> 每次 agent 犯错，不要寄希望于"下次做对"。改造环境，让它不可能再用同样的方式犯错。

这句话精准地定义了 harness 的本质：**不是教 agent 做什么，而是让环境保证 agent 只能做对的事**。

### 1.3 一场关于"围墙"的共识

2026 年 2 月起，这个认知从个人观点变成了行业共识——而且大家从不同方向抵达了同一个终点。

有人关注**可靠性**：OpenAI 用 Codex agent 从空 repo 构建完整产品，零行人写代码，发现 harness 的工程设计决定了 agent 能否长时间可靠运行。有人关注**学科定位**：Birgitta Böckeler 在 Martin Fowler 的网站上撰文，将 Harness Engineering 定位为软件工程实践的新分支——不是 AI 研究的分支，是工程实践的分支。有人关注**评估能力**：Anthropic 提出 GAN 式 Generator/Evaluator 架构，核心发现是模型不能可靠地评估自己的工作，必须由 harness 提供外部验证环。

还有人把话说得更绝。Anup Jadhav 在分析 Stripe Minions 架构后总结——"The Walls Matter More Than the Model"，围墙比引擎重要。Philipp Schmid 从数据视角补了一刀——"The Harness is the Dataset"，harness 捕获的工作轨迹本身就是竞争壁垒。

> "2025 Was Agents. 2026 Is Agent Harnesses." — Aakash Gupta

GitHub 上甚至已经有了专门的 awesome-agent-harness 合集(https://github.com/AutoJunjie/awesome-agent-harness)，收录各家关于 harness 的文章、工具和实践。

---

## 二、现有 Harness 解决了什么，还没解决什么

### 2.1 代码级 Harness 已经成熟

当前主流的 agent harness 都聚焦在**代码执行层**：

**Claude Code** 构建了最完整的六层架构：
- CLAUDE.md（项目上下文）→ Tools/MCP（能力接入）→ Skills（方法论）→ Hooks（机械约束）→ Subagents（隔离工作者）→ Verifiers（验证循环）

**Codex** 走的是云沙箱路线：
- Agent 拿到一个空白环境，读代码、做计划、写代码、跑测试、交 PR。GPT-5.3-Codex 跑了 25 小时不间断，13M token，30K 行代码。

**Cursor** 是 IDE 原生集成：
- 实时协作，视觉反馈，360K 付费用户。

这些 harness 各有所长，但解决的问题是同一类：**agent 怎么写代码**。包括怎么读文件、怎么调工具、怎么跑测试、出错了怎么恢复、上下文满了怎么压缩。

### 2.2 但"写什么代码"还是蛮荒地带

当 agent 从单任务（修一个 bug）升级到多任务（做一个 feature），从单 agent 升级到多 agent 团队协作，代码级 harness 就不够用了。

缺失的环节：

- **需求理解**：这个任务从哪来？需求是否被充分理解？agent 是在正确的理解上执行，还是在错误的假设上高效产出垃圾？
- **任务编排**：5 个 agent 同时工作时，谁干什么？依赖关系是什么？两个 agent 同时抢一个任务怎么办？
- **验收闭环**：任务完成后，谁来验证？验证标准是什么？agent 自己说"做完了"可信吗？
- **迭代节奏**：一轮做完后，下一轮自动开始了吗？下游任务知道上游已完成了吗？

类比一下：现有的 harness 给了 agent 一个配置齐全的**工位**——双屏显示器、机械键盘、IDE 全装好。但没有给它一个**项目部**——没有需求评审、没有任务看板、没有 Sprint 节奏、没有验收标准。

Agent 知道怎么敲键盘，但不知道为什么敲、敲完给谁看、下一步做什么。

---

## 三、项目管理 Harness：让 Agent 拥有完整的迭代环境

Chorus 的定位不是替代 Claude Code 或 Codex——它在这些代码级 harness 之上，提供**项目级 harness**，让 agent 拥有从想法到验收的完整迭代环。

### 3.1 完整管道：六个阶段，每个都有 harness 约束

| 阶段 | 谁在做 | 做什么 |
|------|--------|--------|
| **Idea** | 人类 | 抛出一个想法，可以很粗糙 |
| **Elaboration** | PM Agent → 人类 | AI 不直接开干，而是向人类提问："目标用户规模？""需要离线支持吗？"人类回答，AI 验证自洽性，有矛盾就追问，直到共识 |
| **Proposal** | PM Agent | 产出文档草案 + 任务依赖图（DAG） |
| **Approval** | Admin / 人类 | 审批方案，通过后任务才实体化 |
| **Execute** | Developer Agent | 认领任务，在 Claude Code 中执行，自检验收标准后提交 |
| **Verify** | Admin / 人类 | 逐条验证验收标准，通过或打回。下游任务自动 unblock，下一波开始 |

这不是一个"任务管理看板"。这是一个**让 agent 知道自己在整个项目中处于什么位置的运行时环境**。

每个阶段的边界都是 harness 级别的约束，不是"建议 agent 遵守的最佳实践"：
- 需求没细化完，**开不了工**
- 方案没审批，**任务不存在**
- 上游任务没验收，**下游任务不会 unblock**
- 做完没过验收，**不算 Done**

这就是 Hashimoto 说的那件事：不是教 agent "你应该先理解需求再动手"——**环境保证了它必须先理解需求才能动手**。

### 3.2 Reversed Conversation：AI 提问，人类回答

传统工作流的信息流向是单向的：

```
人写 Prompt → AI 执行 → 人检查结果 → 不满意改 Prompt → AI 重来
```

这个模式的致命问题：**agent 在错误的理解上高效执行**。它可能写了 500 行完美的代码，但解决的是错误的问题。然后你改 prompt 让它重来，它又写了 500 行完美的代码，解决的是另一个错误的问题。

Chorus 的 Elaboration 机制反转了对话方向：

```
人提想法 → AI 提问 → 人回答 → AI 验证答案自洽性 → 有矛盾就追问 → 共识 → 再开干
```

PM Agent 读完一个 Idea 后，不是直接开干，而是生成一组结构化问题。比如人说"我要用户认证"，PM 会问：

- 预计用户规模？（< 100 / 100-1k / 1k-10k / > 10k）
- 需要离线支持吗？（完整 / 只读 / 不需要）
- 第三方集成？（OAuth / OIDC / 自研）

如果人回答了"需要离线支持"但又说"要实时同步"，PM 会追问——因为这两个需求在某些场景下是矛盾的。

> Harness 的价值不只是"让 agent 做得快"，更是"让 agent 做对的事"。Elaboration 是 Chorus 在 harness 层面对需求质量的保障：不是靠 agent 的"理解力"，而是靠**结构化问答的流程约束**。

### 3.3 DAG + Wave 验证：多 Agent 并行不乱序

当一个 Proposal 产出 8 个任务、3 层依赖时，Chorus 构建 Task DAG（有向无环图），并用 Wave 模型管理执行节奏：

```
Wave 1: [Task A] [Task B] [Task C]  ← 无依赖，可并行
         ↓         ↓
Wave 2:      [Task D] [Task E]      ← 依赖 Wave 1 的任务
                  ↓
Wave 3:          [Task F]           ← 依赖 Task E
```

关键设计决策：**不是在执行时强制阻塞，而是在验证时卡住——上游没验收，下游就不会开放**。

- Wave 1 的任务可以被多个 agent 并行认领执行
- 每个 agent 完成后提交验收
- Wave 1 全部验收通过后，Wave 2 自动 unblock
- 如果 Wave 1 某个任务验收失败被打回，依赖它的下游任务不会 unblock

这正是 Stripe 说的 "The Walls Matter More Than the Model"：DAG 就是墙。Agent 不需要"理解"依赖关系——**环境本身阻止了乱序执行**。

### 3.4 验收不是可选项

Anthropic 的工程博客指出：**模型不能可靠地评估自己的工作**。这是他们提出 GAN 式 Generator/Evaluator 架构的核心前提。

Chorus 在项目层面实现了这个原则：

1. **Developer Agent 完成任务后，先跑 Acceptance Criteria 自检**——逐条对照验收标准，标记每一条是否满足
2. **自检通过后提交验收，由 Admin 或人类逐条确认**——不是 agent 自己说了算
3. **验证失败可以打回**——附带反馈，agent 修改后重新提交

> Agent 说"做完了"，和 Admin 验证过"确实做完了"，是两件完全不同的事。Chorus 把这个区分编码成了 harness 的一部分，不依赖任何人"记得去检查"。

---

## 四、为什么项目管理层面的 Harness 是缺失的一环

回到最初的问题：行业已经证明 harness 比模型重要。SWE-bench 17 题的差距，来自代码执行层的 harness 差异。

那在项目层面呢？

想象一下：10 个能力相同的 agent 组成一个团队。一组在没有项目 harness 的情况下协作——Team Lead 用自然语言分配任务，agent 自己决定执行顺序，做完自己汇报，没有验收环节。另一组使用项目 harness——需求经过结构化细化，任务按 DAG 编排，执行有 session 追踪，完成有验收闭环。

哪组的产出更可靠？

人类软件团队几十年的工程实践早就给出了答案：**个人能力 × 协作效率 = 团队产出**。再优秀的工程师，在没有 Jira/Linear、没有 Sprint、没有 Code Review 的环境里远程协作，也会陷入混乱。

Agent 团队没有理由例外。Chorus 做的事情，本质上就是给 agent 团队一个 **agent-native 的 Jira**——**不是把人类的项目管理工具套在 agent 身上，而是从 agent 的工作方式出发，重新设计需求细化、任务编排和验收闭环**。

代码级 harness 解决了 **"每个 agent 单独工作时的表现"**。项目级 harness 解决了 **"一群 agent 一起工作时的表现"**。前者的价值已被 SWE-bench 证实，后者的价值只会更大——因为协作的复杂度远高于单任务执行。

---

## 五、结语

> "2025 Was Agents. 2026 Is Agent Harnesses." — Aakash Gupta

这句话需要一个补充：

2026 年的 Harness Engineering 有两层。**第一层是代码级 harness**——Claude Code、Codex、Cursor 已经做得很好。**第二层是项目级 harness**——从想法细化到任务验收的完整迭代环境——这是正在被填补的空白。

| 层次 | 解决的问题 | 代表 |
|------|-----------|------|
| 代码级 Harness | Agent 怎么写代码 | Claude Code, Codex, Cursor |
| 项目级 Harness | Agent 怎么做项目 | Chorus |

两层结合，agent 才拥有完整的工作环境：知道做什么（Idea + Elaboration）、怎么做（Code Harness）、做完给谁看（Verify）、下一步是什么（DAG unblock）。

当模型能力越来越强、越来越同质化，决定 agent 上限的不再是它有多聪明，而是它被放在什么样的环境里工作。

Harness 不是辅助。Harness 是上限。

---

## 引用与参考

- Chorus — AI-DLC Agent Collaboration Platform (https://github.com/Chorus-AIDLC/Chorus)
- Mitchell Hashimoto, "My AI Adoption Journey — Step 5: Engineer the Harness" (https://mitchellh.com/writing/my-ai-adoption-journey#step-5-engineer-the-harness)
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world" (2026.02.11) (https://openai.com/index/harness-engineering/)
- Birgitta Böckeler / Martin Fowler, "Harness Engineering" (2026.02.17) (https://martinfowler.com/articles/exploring-gen-ai/harness-engineering.html)
- Anthropic Engineering, "Effective harnesses for long-running agents" (2025.11.26) (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic Engineering, "Harness design for long-running application development" (2026.03.24) (https://www.anthropic.com/engineering/harness-design-long-running-apps)
- Anup Jadhav, "Stripe's coding agents: the walls matter more than the model" (2026.02.20) (https://www.anup.io/stripes-coding-agents-the-walls-matter-more-than-the-model/)
- Philipp Schmid, "The importance of Agent Harness in 2026" (2026.01.05) (https://www.philschmid.de/agent-harness-2026)
- Aakash Gupta, "2025 Was Agents. 2026 Is Agent Harnesses." (2026.01.07) (https://aakashgupta.medium.com/2025-was-agents-2026-is-agent-harnesses-heres-why-that-changes-everything-073e9877655e)
- LangChain Blog, "The Anatomy of an Agent Harness" (2026.03.10) (https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- AutoJunjie, "awesome-agent-harness" (https://github.com/AutoJunjie/awesome-agent-harness)
