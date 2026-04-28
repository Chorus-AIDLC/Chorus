---
title: "Chorus v0.6.7: Codex 用户，我们来了"
description: "之前 Chorus 的插件只给 Claude Code 用。现在 Codex CLI 也能一行命令接入。"
date: 2026-04-28
lang: zh
postSlug: chorus-v0.6.7-release
---

# Chorus v0.6.7: Codex 用户，我们来了

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.7 发布。这个版本主要做了一件事：Codex CLI 也能用上 Chorus 插件了。

---

## "我用的是 Codex，能接吗？"

从 v0.6.0 到 v0.6.6，Chorus 的插件一直只对 Claude Code 开放。Codex CLI 用户每次问起来，答案都是"可以接 MCP，但插件用不了"。

但 MCP 只是把工具暴露出来。真正让 Chorus 好用的是插件：它会在合适的时机自动 checkin、提醒 sub-agent 去 review、跟着任务状态走。插件在后台默默做完这些，用起来就很顺；没有这些，整个流程就得手动一步步敲命令串起来。Codex 用户之前拿到的，是半成品。

v0.6.7 把这个缺口补上。

---

## 一行命令接入 Codex

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

脚本会帮你改好 `~/.codex/config.toml`，把 MCP 和 hooks 接上，再装好 7 个工作流 skill（chorus/idea/proposal/develop/review/quick-dev/yolo）和 2 个 reviewer skill。跑一次就行，重复跑也没问题。重启 Codex 就能用。

有一点要注意：Codex 的 skill 调用跟 Claude Code 不一样。Claude Code 里输 `/chorus:develop`，Codex 里输 `$develop`。内容一样，前缀不同。

不想记命令也行，Chorus 里的 Install Guide 现在有 Codex 这一栏，夹在 Claude Code 和 OpenClaw 中间，复制 key、跑 installer、测连接，三步点完就行。

---

## 其他

- **工作区选择器**：同一个邮箱属于多个 Company 时，登录页会让你挑进哪个 workspace，不用再换号。
- **Logout 不再 signout IdP**：登出只清本地 session，IdP 那边的 SSO session 留着，下次静默续上。
- **更完整的连接文档**：新增 `CONNECT_CLAUDE_CODE` / `CONNECT_CODEX` / `CONNECT_OTHER_AGENTS` 三份中英文档，每种客户端的接入路径都讲清楚。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

Codex CLI 插件：

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

v0.6.7 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.7) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.7](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.7)
