---
title: "Chorus v0.6.2: 不装数据库也能跑"
description: "还在为本地开发装 PostgreSQL 发愁？PGlite 内嵌模式让你一个容器启动 Chorus。另外，端口变了，升级前请看这里。"
date: 2026-04-17
lang: zh
postSlug: chorus-v0.6.2-release
---

# Chorus v0.6.2: 不装数据库也能跑

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.2 来了。

上个版本发了之后收到不少 Issue 和反馈，感谢各位。这次没加新的工作流功能，主要是把大家反馈的问题修了，顺便把上手门槛再往下压一压。

---

## ⚠️ 先说个 Breaking Change：端口变了

默认端口从 3000 换成 8637 了。

为啥改？3000 实在太挤了。React 用 3000，Next.js 用 3000，Express 也用 3000。本地同时跑 Chorus 和随便哪个前端项目，基本都会撞。

8637 不太会跟别人冲突。文档、Docker Compose、CDK、插件脚本全都同步改了。如果你的部署脚本或反向代理里写死了 3000，升级前记得改一下。

---

## 一个容器就能跑

之前 `docker compose up` 会拉起两个容器：应用 + PostgreSQL。对于本地试用来说，单独跑一个数据库有点重了。

v0.6.2 加了 PGlite 内嵌模式。PGlite 是编译成 WASM 的 PostgreSQL，直接跑在 Node.js 进程里，数据存本地文件。现在 Docker Compose 简化到只有一个容器，不用单独跑数据库，不用配 `DATABASE_URL`，本地运行的门槛低了不少。

生产环境还是建议用独立的 PostgreSQL。PGlite 解决的是"想试试 Chorus"这个场景，第一次体验不应该从装数据库开始。

---

## 其他改动

- **Pino 结构化日志**：干掉了满天飞的 console.log，生产环境输出 JSON 格式，接 CloudWatch / ELK 方便多了。
- **MCP 工具调用日志**：所有 MCP 调用都会记下来，包括被业务逻辑拒绝的那些，排查 Agent 行为的时候不用猜了。
- **进度条修复**：已关闭的 Task 之前不算进度，现在算了。
- **OIDC 登录修复**：默认登录流程里 oidcSub 唯一约束冲突的问题修了。
- **任务重新分配**：已经分配给别人的任务现在可以直接改分配，不用先释放再重新指派。

---

## 升级

```bash
# 拉最新版
git pull origin main

# 端口变了！
# 旧：http://localhost:3000
# 新：http://localhost:8637
```

v0.6.2 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.2)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.2](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.2)
