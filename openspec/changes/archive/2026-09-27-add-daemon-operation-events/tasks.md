## 1. 服务端专用轮次协议与三代客户端兼容

- [x] 1.1 按技术设计 §1/2/4 实现 nullable operationPayload、两个 canonical trigger、创建/Research 事务、pending-turn 投影及 turn-advance 协议。统一 Research/操作分类与 SQL 谓词，保留审计、origin/cwd、阶段锁和历史记录；避免通知产生第二轮次。包括服务器兼容写入开关和迁移说明。设计中的新字段/参数为拟实现契约，落地前核对现有 API 与 Prisma 生成结果。
- [x] 1.2 验证：迁移只新增可空列；两种创建模式原子写入 Idea/session/专用 turn，载荷校验与 3000 字描述预算通过；Research 每次提交独立轮次且保持资格和澄清状态。；operationProtocol=1 返回规范事件，无该能力返回同 UUID human_instruction 投影；通知与 deliver_turn 不产生第二轮次，原有普通指令与 Yolo 不变。；三代 turn-advance/FIFO/coalescing 按设计契约隔离正确，终态幂等与 backend/usage 归属正确，历史 Research/NULL prompt 兼容。 operationProtocol=1 单独声明也启用隔离，不能落入 legacy FIFO。；数据库集成覆盖 canonical Research 无前缀的读/启动门禁、后代开发竞态退休、exact-turn 重复 running 拒绝、错误 origin/company/agent 和 pending launch abort 边界。；服务端先行部署及关闭新写入的兼容回退可验证；已存 canonical 行在回退模式下仍可读取和确认。

Chorus task draft: 9705d7b4-db7e-43a3-b8fe-161d17ad978d
依赖：无

## 2. CLI 专用操作路由、串行执行与精确回报

- [x] 2.1 按技术设计 §2/3 接入 operationProtocol=1，pending router/prompts 以结构化 kind/mode 调用 Idea、decompose 或 research-only；概括现有 Research 的 exact admission、隔离队列和终态 reporter。保留旧服务器/历史行 fallback、冲突恢复和 backend session/cwd 约束。 同步 OpenClaw 通知排除与 lockstep guard：只排除两个 turn-delivered 操作，不增加通知执行路径。
- [x] 2.2 验证：两个 canonical 操作在同一根会话的串行队列独立执行；普通与主题分解模式、researchFirst、Research 执行后结束等提示词边界覆盖，用户正文不决定事件类型。；新 CLI 声明两个协议；连旧服务器可按原指令执行；载荷缺失/版本不支持/身份矛盾时不 spawn，错误可见，pending 重连可重试。；实时与重连同 turn 去重、普通消息与操作混合队列不合并专用项；失败准入不 spawn，运行/终态及预启动中断关联精确 turn。；测试覆盖 cwd/config 错误、重复投递、失败/重试 reporter、backend 冲突、token usage 与新人工操作解除既有 deterministic conflict guard；原普通消息/crash-resume 回归通过。 OpenClaw lockstep 明确排除两个专用操作，其它 wake 缺失仍失败。

Chorus task draft: 6e168f42-af51-42ce-8526-70e9a3070d0d
依赖：9705d7b4-db7e-43a3-b8fe-161d17ad978d

## 3. 创建与 Research 提交反馈及专用操作展示

- [x] 3.1 按技术设计 §5 修改两个成功回调，取消自动 openChatForSession 和隐藏焦点；保留手动入口、列表/状态刷新、失败重试与 Agent/cwd 选择。补齐 turn-band/通知/transcript 操作标签和四语言文案，并同步 docs/design.pen 对应交互与标签。无需改变界面风格或创建新页面。
- [x] 3.2 验证：普通/主题分解创建成功关闭输入对话框并显示本地化已提交反馈，留在当前页面；Research 成功保留已排队反馈和状态刷新，不自动打开或切换聊天。；手动会话入口及 transcript 仍可用，无延迟 focus 残留；已打开会话不被关闭/切换，静态创建及通用 ad-hoc 调用者行为不变。；专用操作显示本地化业务名称及真实轮次状态，不将系统指令误呈现为人工输入；en/zh/ja/ko、提交错误与可重试状态完整。 canonical 操作的 transcript seq=0 位置、cursor、计数及 UUID 保持稳定，不把兼容 prompt 合成为 user 消息，覆盖翻页/live 去重。；组件及浏览器验收覆盖 light/dark、桌面/窄屏、键盘焦点恢复、双击防重复及再次 Research；docs/design.pen 经 Pencil 更新并保存可审查结果。

Chorus task draft: a2b6226f-b089-4036-a86f-531f4785fbe6
依赖：9705d7b4-db7e-43a3-b8fe-161d17ad978d

## 4. 专用操作端到端兼容与恢复验收

- [x] 4.1 汇合 T2/T3，验证设计的三代客户端与服务端组合；补齐 docs/verification 的结果和协议部署/兼容回退说明。使用真实数据库集成和实际 CLI/HTTP 路径，不能只依靠 mock 或源码字符串断言。此任务验证并修复整合缺口，不新增产品范围。
- [x] 4.2 验证：新协议、新旧 Research 协议、无协议 CLI 的创建/分解/Research 从派发到终态通过；旧 CLI 已完成或 merged turn 不会在重连重放，新 CLI/旧服务器 fallback 可执行。 包括只声明 operationProtocol=1 的边界组合。；同一请求实时+重连、多连接、两次 Research 与普通消息混合、先排队后开发、后代执行及失败重连覆盖，确认没有错误实例执行、重复启动或误消费普通消息。；真实浏览器验证无自动弹窗、手动历史和正确状态；UI 四语言/明暗/窄屏证据与设计稿同步可追溯。；TypeScript、相关 lint、服务/HTTP/CLI/组件/既有 OpenClaw 回归及 OpenSpec strict 通过；记录实际命令、结果、部署顺序与可验证回退限制，不提前标记未运行验证为通过。

Chorus task draft: cb455562-5104-4b93-9a31-dae53a6943d3
依赖：6e168f42-af51-42ce-8526-70e9a3070d0d, a2b6226f-b089-4036-a86f-531f4785fbe6

## 本次用户豁免

2026-09-27 08:18 UTC，Idea 评论 e072b3a2-15df-4f98-9dd3-595eadc1c49d：“不用管pen文件，继续推进”。T3/T4 中 docs/design.pen 同步部分据此豁免，保留其它代码、浏览器及独立审查要求。
