---
title: "Chorus v0.18.0：内置轻量级本地 Spec 管理"
description: "不想为每次改动都引入完整的 OpenSpec 流程？Chorus 现在自带一套更轻的本地 Spec 机制。"
date: 2026-09-11
lang: zh
postSlug: chorus-v0.18.0-release
---

# Chorus v0.18.0：内置轻量级本地 Spec 管理

OpenSpec 适合需要完整设计、严格校验和长期维护的改动。但不是每个项目、每次修改都需要走完一套完整流程。

有时只需要一份跟着代码进 Git 的当前规格，再为这次改动留一份 PRD 或技术设计。以前不使用 OpenSpec 时，Chorus 没有统一的本地 Spec 方案，这些内容很容易重新散进聊天记录和临时文档。

v0.18.0 加入了 Chorus 自带的 `spec-lite`。它是 OpenSpec 的轻量补充，不是替代品。项目已经在使用 OpenSpec 时，原来的流程保持不变；不想引入完整 OpenSpec 流程时，则可以用普通 Markdown 在仓库里管理规格。

## 一份长期 Spec，加上每次变更的文档

spec-lite 为每项能力保留一份持续更新的本地规格：

```text
.chorus/specs/<slug>/spec.md
```

它记录这项能力当前的 Intent、Requirements 和 Non-goals，直接提交到 Git，不同步到 Chorus。后续修改同一项能力时，继续更新这一个文件，Git 历史就是它的变更记录。

每次具体改动另建一个带日期的目录，里面必须有 `prd.md`，需要时再加 `tech_design.md`、`adr.md` 或其他文档：

```text
.chorus/specs/<slug>/2026-09-11-<change-slug>/
```

这些变更文档按原文件内容镜像成 Chorus Document Draft，Proposal 批准后成为正式 Document。任务状态仍然留在 Chorus，不额外维护一份 `tasks.md`。

这样分工比较简单：

- `.chorus/specs/<slug>/spec.md` 保存这项能力当前有效的规格
- 日期目录保存某一次改动的 PRD 和技术设计
- Chorus Document 保存供 Proposal 审批和团队协作使用的镜像
- Chorus Task 继续负责执行状态和验收

仓库里有可用的 OpenSpec 时，流程仍然优先使用 OpenSpec；没有时才回退到 spec-lite。也可以用 `CHORUS_SPEC_MODE=lite|openspec|off` 明确指定。显式要求 OpenSpec 但环境不可用时会直接报错，不会静默切换。

Claude Code、Codex、OpenClaw、Kiro、Pi 和 dsh 都支持这套目录和流程。换一个 Agent 接手，读取的仍然是仓库里的同一份 Spec。

## Daemon Agent 协作时，回复回到原来的会话

多个 daemon Agent 可以通过 Idea 指派、Task 指派和 `@mention` 互相唤醒，但之前缺少一段关键上下文：被叫醒的 Agent 不知道发起者当前在哪个 session 里等回复。

例如 Agent A 在一个 Idea 上叫醒 Agent B。B 完成工作后，如果另外开一段对话汇报，A 原来的 session 仍然收不到这次接力的结果，协作会被拆成两条线。

v0.18.0 为这类唤醒增加了 live session anchor。由 Agent 触发的 Idea 或 Task 唤醒，会在发起者的对应 Idea session 在线时，把这段会话的锚点附在通知里。Task 唤醒会先找到它直接所属的 Idea，再查找发起者在这个 Idea 上的 session。被唤醒的 Agent 会收到明确提示：在当前 Idea 或 Task 上回复，消息就能沿现有回程路径进入发起者正在进行的 session。

这不是一套新的强制路由。发起者离线、在对应 Idea 上没有 session，或唤醒不属于 Idea/Task 时，不会生成 anchor，仍然使用原来的 notify-only 行为。anchor 只负责告诉 Agent 这次回复应该落到哪段现有会话。

## 这一版的其他改进

Proposal reviewer、Task reviewer 和代码总审都增加了 Intent Alignment。对直接关联 Idea 的工作，reviewer 会回看人类写下的 Idea、Elaboration 回答和评论，检查范围扩张、需求遗漏，以及 AC 通过但原始目标没有完成的情况。

每个 Agent profile 也可以在 `~/.chorus/daemon.json` 中保存自己的 `args` 和 `env`，供 `chorus agents run` 和可唤醒 backend 共用。前台启动和 daemon 唤醒不再需要分别维护模型、思考强度和 provider 配置。

另外，文档开头的扁平 frontmatter 现在会显示成 metadata card；Tracker 侧栏操作则集中进 Actions 菜单，手机端使用 bottom sheet。

## OpenSpec 之外，多一个轻量选择

spec-lite 不试图取代 OpenSpec。需要完整变更模型、严格验证和复杂规格管理时，OpenSpec 仍然是默认选择。

当项目只需要一套简单、可读、能进 Git 的本地 Spec 时，Chorus 现在自带了一条更轻的路径。它保留必要的规格和变更记录，同时继续使用 Chorus 的 Proposal、Document、Task 和 reviewer 完成协作与验收。

---

## 升级

```bash
npm install -g @chorus-aidlc/chorus@0.18.0
chorus agents add
```

完整变更见 [GitHub Release v0.18.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.18.0)。问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。
