---
title: "Chorus v0.15.0: 项目级 Agent 工作目录"
description: "当多个项目和 Agent 共用一组 daemon 时，怎样确保每项工作始终进入正确的主机和目录？"
date: 2026-08-03
lang: zh
postSlug: chorus-v0.15.0-release
---

# Chorus v0.15.0: 项目级 Agent 工作目录

在一台开发机上维护多个仓库，或者让同一个 Agent 服务多个项目时，daemon 的启动目录不一定就是任务需要的工作目录。目录选择如果只依赖当前在线实例或每次手动指定，项目创建、任务分配、会话恢复等入口可能得到不同结果。

Chorus v0.15.0 增加了项目级 Agent 工作目录配置，并将它应用到新工作分配、唤醒、恢复和后续对话中。

## 为项目中的每个 Agent 配置工作目录

每位用户现在可以在项目设置中为每个 Agent 指定主机和工作目录。这项配置按用户、项目和 Agent 分别保存，不会覆盖其他项目成员的设置。同一个项目中的 Claude Code、Codex、Kiro 等 Agent 可以使用不同路径；同一个 Agent 参与不同项目时，也可以分别配置。

配置完成后，Chorus 会将该目录作为分配给 Agent 的新工作的固定目标。以下入口会使用同一项配置：

- 新建或重新分配 Idea、Task；
- 对话式创建 Idea；
- 通过 `@mention` 唤醒 Agent；
- 开始开发和 Yolo 流程；
- 后续阶段推进和会话启动。

界面会显示当前绑定的主机和目录。固定目录存在时，相关操作不再重复要求选择在线实例或临时目录。

如果目标主机离线，需要在线执行的操作会明确失败，可恢复的唤醒则保留为通知。Chorus 不会自动切换到其他主机或目录。路径无效或不在允许范围内时，也会返回明确的校验错误。

未配置固定目录的项目继续使用原有行为，包括从在线实例中选择目录，或为当前操作临时浏览其他目录。

## 由 daemon 提供安全的目录发现

浏览器和 Chorus 服务端不直接读取 Agent 主机上的文件系统。可选目录由对应 daemon 根据 `browseRoots` 提供；未显式配置时，默认范围是运行 daemon 的用户主目录。

目录发现接口采用以下限制：

- 只允许访问 daemon 明确配置的根目录；
- 每次只返回一层子目录；
- 过滤隐藏目录、符号链接和无权限路径；
- 拒绝超出允许根目录的请求；
- 保存和执行前再次校验目标路径。

项目固定目录和单次临时目录使用同一套目录选择与校验流程。输入路径前缀时，界面会从对应主机获取候选目录，并支持方向键、Tab 和 Enter 操作。

## 保持任务和会话的目录一致

项目设置决定之后创建的新工作进入哪里。已经建立执行目标的 Idea 和 Task 会保留原来的绑定，已经启动的 daemon 会话则继续使用自己的 `runtimeCwd`。

因此，修改项目默认目录不会让进行中的会话在下一轮切换仓库。恢复会话、继续对话和后续回合仍会回到原来的主机和目录，新创建的工作才使用更新后的配置。

项目固定目录、单次临时目录、已有实例绑定和未配置时的回退路径，现在都通过同一套目录解析逻辑确定执行位置。

## Codex 集成改进

v0.15.0 还包含两项 Codex 集成修复。

首先，Chorus 现在会单独保存 Codex 的后端 thread ID。Chorus 内部会话 ID 继续用于业务路由，复制会话 ID 和执行 `codex exec resume` 时则使用可恢复的 Codex thread ID。旧会话没有后端 ID 时，复制按钮不会显示，也不会退回复制 Chorus 内部 ID。

其次，Codex 插件移除了不再需要的 Chorus session 管理指引。Codex 工作流可以直接领取、执行和提交任务，启动上下文刷新和结构化错误处理保持不变。

## 总结

v0.15.0 将 Agent 的主机和工作目录纳入项目配置，并在任务分配、唤醒与会话生命周期中保持一致。对于同时维护多个仓库、多个 Agent 或多台开发主机的团队，这项配置可以减少重复选择，也能避免新任务和进行中的会话进入不同目录。

---

## 升级

```bash
npx @chorus-aidlc/chorus@0.15.0
```

发布后可在 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.15.0) 查看完整变更。

问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.15.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.15.0)
