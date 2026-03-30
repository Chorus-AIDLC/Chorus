# Synapse 深度分析：从 Chorus 到科研协作平台的演化

> **分析对象**: [Synapse](https://github.com/Vincentwei1021/Synapse) — 基于 Chorus AI-DLC 框架的科研版本
> **分析日期**: 2026-03-30

---

## 1. 设计理念

### 1.1 核心转变：从软件工程到科学研究

Chorus 的核心理念是 **"Reversed Conversation"（反转对话）**—— AI 提议、人类验证。Synapse 继承了这一理念，但将应用领域从 **软件开发生命周期（SDLC）** 迁移到 **科研生命周期**。

| 维度 | Chorus | Synapse |
|------|--------|---------|
| **领域** | 软件开发 | 学术 / 实验研究 |
| **核心流程** | Idea → Proposal → Task → Verify | Research Question → Experiment Design → Experiment Run → Verify |
| **角色体系** | PM / Developer / Admin | Research Lead / Researcher / PI (Principal Investigator) |
| **工作单元** | 代码实现任务 | 实验执行与数据收集 |
| **验证标准** | 功能测试、代码审查 | 指标阈值、可复现性、Go/No-Go 判定 |
| **独有能力** | — | 文献管理、GPU 资源调度、基线对比、假设检验、自主实验循环 |

### 1.2 设计哲学

Synapse 的核心设计哲学可以归纳为三点：

1. **结构化假设驱动**：科研不同于工程——每个实验背后必须有明确的假设（Hypothesis Statement）和零假设（Null Hypothesis）。Synapse 强制将这一学术规范嵌入工作流。

2. **可复现性优先**：通过 `ExperimentRegistry` 模型记录配置、环境、随机种子、指标和产出物，使每次实验天然具备可复现性追踪能力。

3. **计算资源感知**：科研实验消耗 GPU 等昂贵计算资源，Synapse 将计算资源管理（池 → 节点 → GPU → 预留）作为一等公民纳入平台。

---

## 2. 数据模型差异

Chorus 有 **21 个 Prisma 模型**，Synapse 扩展到 **31 个**——新增 10 个科研特有模型，并对核心模型做了语义重命名和字段扩展。

### 2.1 核心模型重命名与扩展

| Chorus 模型 | Synapse 模型 | 新增关键字段 |
|-------------|-------------|-------------|
| `Project` | `ResearchProject` | `goal`, `datasets`, `evaluationMethods`, `latestSynthesisAt`, `latestSynthesisSummary`, `computePoolUuid`, `autonomousLoopEnabled`, `autoSearchEnabled`, `deepResearchDocUuid` |
| `Idea` | `ResearchQuestion` | `hypothesisStatement`, `nullHypothesis`, `priorWork`, `researchType` (exploratory/confirmatory/replication), `parentQuestionUuid`, `generatedByAgentUuid`, `reviewStatus`, `reviewNote` |
| `Task` | `ExperimentRun` | `experimentDesignUuid`, `experimentConfig`, `experimentResults`, `baselineRunUuid`, `computeBudgetHours`, `computeUsedHours`, `outcome`, `earlyStopTriggered` |
| `Proposal` | `ExperimentDesign` | 保持草案容器模式，语义重命名 |
| `ElaborationRound` | `HypothesisFormulation` | 强调假设形成过程 |
| `ElaborationQuestion` | `HypothesisFormulationQuestion` | 同上 |

### 2.2 全新模型（10 个）

#### 文献管理
- **`RelatedWork`** — 学术论文追踪，支持 arXiv 集成和自动元数据抓取

#### 实验管理
- **`Experiment`** — 独立于 ExperimentRun 的实验实体，带 `liveStatus` / `liveMessage` / `liveUpdatedAt` 实时状态
- **`ExperimentProgressLog`** — 实验进度日志，按阶段（phase）记录
- **`ExperimentRegistry`** — 可复现性追踪（config, environment, seed, metrics, artifacts）
- **`Baseline`** — 性能基线，用于实验间对比

#### 计算资源
- **`ComputePool`** — GPU 计算资源池
- **`ComputeNode`** — 计算节点（EC2 实例，SSH/SSM 访问）
- **`ComputeGpu`** — GPU 设备清单及遥测数据（利用率、温度、显存）
- **`RunGpuReservation`** — GPU 到实验运行的预留
- **`ExperimentGpuReservation`** — GPU 到实验的预留

### 2.3 AcceptanceCriterion 增强

这是一个特别值得关注的改动。Chorus 的验收标准是纯文本描述，Synapse 将其升级为 **结构化的 Go/No-Go 判定**：

```
新增字段:
  metricName    String?    // 指标名称，如 "accuracy", "F1-score"
  operator      String?    // 比较运算符: >=, <=, >, <, ==
  threshold     Float?     // 阈值: 0.95
  isEarlyStop   Boolean    // 是否触发提前停止
  actualValue   Float?     // 实验实际值
```

这使得系统可以 **自动判定实验是否达标**，而不依赖人工逐条审查。

---

## 3. 角色体系重构

### 3.1 角色映射

| Chorus 角色 | Synapse 角色 | 职责变化 |
|------------|-------------|---------|
| `pm_agent` | `research_lead` / `research_lead_agent` | 从产品需求管理转为实验设计编排 |
| `developer_agent` | `researcher` / `researcher_agent` | 从代码实现转为实验执行与数据收集 |
| `admin_agent` | `pi` / `pi_agent` | 从系统管理转为学术 PI 角色——审批实验设计、验证结果、判定可复现性 |

### 3.2 PI（Principal Investigator）角色

这是最有意思的角色设计。在学术场景中，PI 不仅是管理员，更是：
- **实验设计审批者**：approve / reject experiment designs
- **结果验证者**：verify experiment runs，判断实验是否达到学术标准
- **可复现性裁判**：`synapse_verify_reproducibility` — 标记实验是否可复现
- **研究问题审查者**：`synapse_pi_review_research_question` — 审核 AI Agent 自动生成的研究问题

PI 拥有最高权限，可以使用所有 Research Lead 和 Researcher 的工具。

---

## 4. 服务层新增（~20 个新服务）

### 4.1 实验管理（10 个服务）

| 服务 | 职责 |
|------|------|
| `experiment.service.ts` | 实验全生命周期管理 |
| `experiment-design.service.ts` | 实验设计草案管理与验证 |
| `experiment-progress.service.ts` | 实时进度日志与状态更新 |
| `experiment-registry.service.ts` | 可复现性注册（配置、环境、种子、指标、产出物） |
| `experiment-run.service.ts` | 运行实例 CRUD |
| `experiment-run-criteria.service.ts` | 验收标准标记与自检 |
| `experiment-run-dependency.service.ts` | 运行依赖 DAG 管理 |
| `experiment-run-lifecycle.service.ts` | 状态机转换与自动化 |
| `experiment-run-query.service.ts` | 复杂查询 |
| `experiment-run-side-effects.service.ts` | 副作用处理（GPU 释放、综述刷新、@mention） |

### 4.2 科研专有（6 个服务）

| 服务 | 职责 |
|------|------|
| `research-project.service.ts` | 研究项目管理（含自主循环、自动搜索配置） |
| `research-question.service.ts` | 层级化研究问题管理（父子关系） |
| `hypothesis-formulation.service.ts` | 多轮 Q&A 假设形成与验证 |
| `related-work.service.ts` | 文献管理 + arXiv 元数据自动抓取 |
| `baseline.service.ts` | 基线创建、切换、对比 |
| `criteria-evaluation.service.ts` | 自动化指标评估 + 提前停止判定 |
| `project-synthesis.service.ts` | 从已完成实验自动生成项目综述文档 |
| `compute.service.ts` | GPU 池管理、节点同步、预留系统、遥测轮询 |

---

## 5. MCP 工具体系（50+ 工具）

### 5.1 工具前缀变更

所有工具从 `chorus_*` 重命名为 `synapse_*`。

### 5.2 全新工具类别

#### 文献工具（Literature）
| 工具 | 功能 |
|------|------|
| `synapse_search_papers` | Semantic Scholar 论文搜索 |
| `synapse_add_related_work` | 手动添加论文（支持 arXiv URL 自动抓取元数据） |
| `synapse_get_related_works` | 获取项目相关文献列表 |

#### 计算资源工具（Compute）
| 工具 | 功能 |
|------|------|
| `synapse_list_compute_nodes` | 列出计算池、节点、GPU |
| `synapse_get_node_access_bundle` | 获取 SSH 凭证（用于已分配的实验） |
| `synapse_sync_node_inventory` | EC2 + GPU 清单同步 |
| `synapse_report_gpu_status` | 遥测上报（利用率、显存、温度） |
| `synapse_start_experiment_run_with_gpus` | 认领运行 + 预留 GPU + 启动（原子操作） |

#### Researcher 专属工具
| 工具 | 功能 |
|------|------|
| `synapse_register_experiment` | 注册实验（可复现性追踪） |
| `synapse_report_metrics` | 上报指标（自动评估 Go/No-Go 标准） |
| `synapse_check_criteria` | 检查当前标准满足情况 |
| `synapse_request_early_stop` | 请求提前停止实验 |

#### Research Lead 专属工具
| 工具 | 功能 |
|------|------|
| `synapse_research_lead_generate_project_ideas` | AI 自主生成研究问题 |
| `synapse_create_baseline` | 创建性能基线 |
| `synapse_compare_results` | 基线对比分析 |
| `synapse_create_rdr` | 创建 Research Decision Record（研究决策记录） |
| `synapse_research_lead_start_hypothesis_formulation` | 启动假设形成（minimal/standard/comprehensive 三档深度） |

#### PI 专属工具
| 工具 | 功能 |
|------|------|
| `synapse_pi_review_research_question` | 审查研究问题（accept/reject） |
| `synapse_verify_reproducibility` | 验证实验可复现性 |
| `synapse_set_active_baseline` | 设置项目活跃基线 |

---

## 6. 关键特性深度解析

### 6.1 层级化研究问题（Hierarchical Research Questions）

Chorus 的 Idea 是扁平列表。Synapse 通过 `parentQuestionUuid` 引入了树状结构：

```
RQ1: Does model X outperform Y on dataset Z?
├── RQ1.1: What is the impact of hyperparameter α?
├── RQ1.2: How does performance vary across data splits?
└── RQ1.3: Is the improvement statistically significant?
```

这反映了真实科研中"大问题拆解为子问题"的思维方式。

### 6.2 假设形成系统（Hypothesis Formulation）

Chorus 的 Elaboration 是通用的需求澄清。Synapse 将其改造为结构化的假设形成过程：

- **三档深度**：`minimal`（快速确认）、`standard`（常规）、`comprehensive`（深度探讨）
- **多轮 Q&A**：Agent 生成方法论相关的结构化问题 → 研究者回答 → 验证 → 必要时追加轮次
- **预定义选项 + 自由文本**：问题可附带选项（如"使用哪种统计检验？"），同时保留 "Other" 自由回答

### 6.3 Go/No-Go 自动判定

这是 Synapse 最精巧的设计之一：

```
实验定义阶段:
  AC1: accuracy >= 0.95           (Go/No-Go)
  AC2: latency <= 100ms           (Go/No-Go)
  AC3: memory_usage <= 8GB        (Go/No-Go, isEarlyStop=true)

实验执行阶段:
  Researcher 调用 synapse_report_metrics({ accuracy: 0.97, latency: 85, memory_usage: 12 })
  → 系统自动评估:
    AC1: 0.97 >= 0.95 ✅ PASS
    AC2: 85 <= 100 ✅ PASS
    AC3: 12 <= 8 ❌ FAIL + isEarlyStop → 触发提前停止通知
```

这将科研中常见的"实验达标判定"从人工检查变为自动化流水线。

### 6.4 计算资源管理

完整的三层资源模型：

```
ComputePool (e.g., "ML Training Cluster")
├── ComputeNode (e.g., "p3.8xlarge - i-0abc123")
│   ├── ComputeGpu (GPU 0: V100, 16GB, 利用率 85%, 温度 72°C)
│   ├── ComputeGpu (GPU 1: V100, 16GB, 空闲)
│   └── ComputeGpu (GPU 2: V100, 16GB, 已预留给 Run-X)
└── ComputeNode (e.g., "p4d.24xlarge - i-0def456")
    └── ...
```

关键能力：
- **原子操作**：`synapse_start_experiment_run_with_gpus` 一步完成 claim run + reserve GPU + start
- **遥测轮询**：GPU 利用率、温度、显存实时上报
- **预算追踪**：`computeBudgetHours` / `computeUsedHours` 控制实验成本

### 6.5 自主实验循环（Autonomous Loop）

```
autonomousLoopEnabled = true
autonomousLoopAgentUuid = <Research Lead Agent>

当项目实验队列清空时:
  → Agent 自动分析已完成实验结果
  → 生成新的研究问题（synapse_research_lead_generate_project_ideas）
  → 设计新实验
  → 提交给 PI 审批
  → 形成持续的科研探索循环
```

类似地，`autoSearchEnabled` 让 Agent 持续发现相关文献。

### 6.6 可复现性追踪（Experiment Registry）

每次实验执行可注册为：

```json
{
  "config": { "learning_rate": 0.001, "batch_size": 32, "epochs": 100 },
  "environment": { "python": "3.11", "torch": "2.1", "cuda": "12.1" },
  "seed": 42,
  "metrics": { "accuracy": 0.973, "f1": 0.968 },
  "artifacts": ["model.pt", "results.csv"],
  "reproducible": null  // PI 验证后设为 true/false
}
```

PI 可通过 `synapse_verify_reproducibility` 审核并标记。

---

## 7. 前端界面差异

### 7.1 导航结构

| Chorus | Synapse |
|--------|---------|
| Projects | Research Projects |
| — | Compute（新增：GPU 池管理） |
| Agents | Agents |
| Settings | Settings |

### 7.2 项目子页面

| Chorus | Synapse | 变化 |
|--------|---------|------|
| Dashboard | Dashboard | 增加实验概览 |
| Ideas | Research Questions | 支持层级、假设字段 |
| — | Related Works | **全新**：文献管理 |
| Proposals | Experiment Designs | 语义重命名 |
| — | Experiments | **全新**：独立实验实体 + 实时状态 |
| Tasks | Experiment Runs | 增加指标、GPU、基线字段 |
| Documents | Documents | 增加实验设计关联 |
| — | Insights | **全新**：项目综述 + 已完成实验分析 |
| Activity | Activity | 增加科研相关活动类型 |

### 7.3 新增 UI 组件

- **hypothesis-formulation-panel** — 假设形成的多轮 Q&A 面板
- **go-no-go-badge** — Go/No-Go 标准状态徽章（✅ Pass / ❌ Fail）
- **live-data-refresher** — 实验实时状态刷新
- **compute-node-form / compute-pool-form** — GPU 资源管理表单
- **design-filter** — 实验设计筛选器

---

## 8. API 与标识符差异

### 8.1 API Key 前缀

```
Chorus:  cho_xxxxxxxx
Synapse: syn_xxxxxxxx
```

### 8.2 新增 API 路由

| 路由 | 用途 |
|------|------|
| `/api/research-projects` | 替代 `/api/projects` |
| `/api/research-questions` | 替代 `/api/ideas` |
| `/api/experiments` | 全新：独立实验管理 |
| `/api/experiment-designs` | 替代 `/api/proposals` |
| `/api/experiment-runs` | 替代 `/api/tasks` |
| `/api/compute-nodes` | 全新：计算节点管理 |
| `/api/compute-pools` | 全新：计算资源池 |
| `/api/ssh-config` | 全新：SSH 配置获取 |

---

## 9. 技术栈差异

基础技术栈完全相同（Next.js 15, TypeScript 5, Prisma 7, PostgreSQL, Redis, MCP SDK）。新增依赖：

| 依赖 | 用途 |
|------|------|
| `@hello-pangea/dnd` | 拖拽排序（实验看板） |
| `shiki` + `streamdown` | 代码高亮（实验结果展示） |

---

## 10. 总结：Synapse 的本质

Synapse 不是简单的"换皮"——它是对 Chorus AI-DLC 框架的 **领域特化（Domain Specialization）**。核心架构（MCP 通信、反转对话、多 Agent 协作、草案→审批流程）完全复用，但在上层注入了科研领域的关键概念：

1. **假设驱动**（而非需求驱动）
2. **指标量化**（而非功能验证）
3. **可复现性**（科研独有需求）
4. **计算资源感知**（GPU 是稀缺资源）
5. **文献生态**（arXiv / Semantic Scholar 集成）
6. **自主探索**（AI Agent 主动提出新实验方向）

这证明了 Chorus 的 AI-DLC 框架具有良好的领域可迁移性——同一套"AI 提议、人类验证"的协作模式，可以从软件工程延伸到科学研究，未来也可能延伸到更多知识密集型领域。
