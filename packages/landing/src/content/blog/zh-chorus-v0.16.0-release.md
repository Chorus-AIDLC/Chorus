---
title: "Chorus v0.16.0：让 Agent 查文档，而不是凭记忆回答"
description: "当用户问 Agent 怎么用 Chorus，它是在复述训练时的记忆，还是在读此刻的文档？"
date: 2026-08-09
lang: zh
postSlug: chorus-v0.16.0-release
---

# Chorus v0.16.0：让 Agent 查文档，而不是凭记忆回答

用户让 Agent 解释某个 Chorus 功能怎么用，Agent 往往会直接回答。但这个回答来自模型训练时见过的内容，而不是产品当前的真实行为。功能改过、流程调整过、参数换过之后，凭记忆给出的答案会和实际不一致，用户又很难当场分辨。

Chorus v0.16.0 把文档站点接入产品，并新增一个 `docs` skill，引导 Agent 在回答前先查阅当前文档。

## 面向 Agent 的文档站点

Chorus 的文档站点部署在 https://doc.chorus-ai.dev。除了给人阅读的页面，它还提供便于 Agent 读取的入口：

- 根目录下的 `/llms.txt` 是一份索引，列出每个文档页面和它的一句话摘要；
- 任意页面 URL 追加 `.md`，即可取到该页的纯 Markdown 原文。

索引只有一份，位于站点根目录，不分语言。页面本身按路径前缀提供多语言版本。

## docs skill

新的 `docs` skill 是一个轻量路由。它不缓存文档内容，而是约定一套访问流程：

1. 先读 `/llms.txt` 索引，按问题挑出相关页面；
2. 给页面 URL 追加 `.md`，取回原文；
3. 基于取回的内容作答，并附上对应的人类可读页面链接。

这样 Agent 的回答基于此刻发布的文档，而不是训练记忆。skill 不内置页面清单，页面增减都以索引为准。

该 skill 覆盖全部六个技能载体：Claude Code、Codex、OpenClaw、Kiro、Pi，以及独立 skill。

## 同时面向用户

文档入口也补齐了给人的路径。英文、中文、韩文、日文四种 README 的头部都加上了文档链接，落地页顶部导航新增「文档」入口，并按语言指向对应版本。

## 总结

v0.16.0 的改动集中在一件事：用户问 Agent 怎么用 Chorus，Agent 现在可以先读当前文档再回答，而不是复述可能已经过时的记忆。

---

## 升级

```bash
npx @chorus-aidlc/chorus@0.16.0
```

发布后可在 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.0) 查看完整变更。

问题和反馈可提交至 [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.16.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.16.0)
