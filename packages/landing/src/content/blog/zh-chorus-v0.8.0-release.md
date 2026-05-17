---
title: "Chorus v0.8.0: Chorus ❤ OpenSpec"
description: "本地写 spec 很爽，但怎么让协作平台跟得上？这版把 OpenSpec 的本地文档流，织进了 Chorus 的 AI-DLC。"
date: 2026-05-17
lang: zh
postSlug: chorus-v0.8.0-release
---

# Chorus v0.8.0: Chorus ❤ OpenSpec

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.8.0 发布。这版核心是一件事：把社区的 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 接进 Chorus 的 AI-DLC 流程，让 spec 文档既能在本地以文件方式跟 agent / 人 / git 协作，又能同步进 Chorus 让其它 reviewer 看到、留痕、走审批。

---

## 协作平台和本地文件，能不能都要

Chorus 的 AI-DLC 是一条 Idea → Proposal → Tasks → Verify 的流水线，整条线靠数据库串起来。proposal 是数据库里的一条记录，document draft 也是。reviewer 上网页看、评论、approve，留痕和审批都很顺。

但写文档这一步就有点别扭。Agent 写完一段 PRD，灌进 `chorus_pm_add_document_draft` 的 `content` 字段；人想顺手改两行，得打开 Chorus 网页编辑器；本地仓库里看不见这份文档，`git diff` 也照不到。

更糟的是 token。markdown 走 MCP 调用，整段要先从 LLM 输出一次，再被 LLM 重新打字进 `content` 字段。三文档的 proposal 镜像一次，content tokens 二十多 K 起步。LLM 重打长 markdown 还不太靠谱，表格对齐会漂、code fence 偶尔被"改对"、长 URL 会断行。

反过来看，本地文件流这套就熟得多。agent 用 editor 写、人用 IDE 改、`git diff` 看变更，开发者每天都在做。只可惜协作平台够不到本地仓库。

这版想做的事，就是把两边接上。

---

## 先聊聊 OpenSpec

[OpenSpec](https://github.com/Fission-AI/OpenSpec) 是 [Fission AI](https://github.com/Fission-AI) 开源的 spec-driven 开发 CLI，思路很简单：所有 spec 都以文件的形式躺在仓库里，用一个固定的文件夹约定组织起来。

```
openspec/
├── changes/
│   └── <slug>/
│       ├── proposal.md       # Why + What changes + Impact
│       ├── design.md         # Architecture, contracts, risks
│       ├── specs/
│       │   └── <capability>/
│       │       └── spec.md   # Delta spec
│       └── tasks.md
└── specs/
    └── <capability>/
        └── spec.md           # Long-term, post-archive spec
```

每个 change 就是 `openspec/changes/<slug>/` 这么个文件夹，proposal、design、spec 各自一份 markdown。spec 文件不写"完整状态"，写 delta，长这样：

```markdown
## ADDED Requirements

### Requirement: Export to CSV
The system SHALL allow users to export task lists to CSV.

#### Scenario: Empty list
- **WHEN** the user clicks Export with zero tasks
- **THEN** an empty CSV with headers is downloaded
```

`## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements` / `## RENAMED Requirements` 这些 delta 块定义"这个 change 改了什么"。change 落地之后跑一次 `openspec archive <slug>`，CLI 把 delta 合并进 `openspec/specs/<capability>/spec.md` 这份长期 spec 里。

这个形态对开发者挺友好。spec 是文件，git 管得住；结构是 `### Requirement: ` + `#### Scenario: WHEN ... THEN ...`，agent 扫得快，人也读得动；delta 块逼你把"改了什么"显式写出来，不会偷偷藏进一大段重写。

只是 OpenSpec 自己就管到这里，本地文件之外的事它不碰。要把它接进 Chorus 这种带 reviewer、走审批、多 agent 协作的平台，中间还得搭一层桥。

---

## 这层桥：插件 wrapper 直接流字节

最朴素的接法是这样：agent 在本地用 OpenSpec 写好文件，再调 `chorus_pm_add_document_draft` 把 markdown 灌进 Chorus。听上去顺，跑起来三个坑：

1. **token 爆掉**，文件内容要先经过 LLM 输出，再被 LLM 重新打一遍。
2. **内容会漂**，LLM 重打长 markdown，表格、fence、长 URL 都不稳。
3. **来源分裂**，本地文件和 Chorus draft 都说自己是真的，diff 看不出哪边对。

v0.8.0 的解法是绕开 LLM。Chorus 插件里多了一个 wrapper 脚本 `chorus-api.sh mcp-tool`，PM skill 把本地文件路径喂给 `json_encode_file` helper：

```bash
json_encode_file() {
  jq -Rs '.' < "$1"   # 把整个文件流成 JSON 字符串
}
```

`jq -Rs '.'` 是字节级编码，反斜杠、引号、换行、code fence、零宽字符全都原样留住。流出来的 JSON 字符串直接拼进 MCP payload 的 `content` 字段，由 wrapper 打到 Chorus 后端。LLM 全程看不到文件正文，只看到一句"我准备 mirror 这个文件"。

落到实处是三件事：

- **content tokens 接近零**。三文档 proposal 镜像一次，原来烧两万 token 的那段彻底消失。
- **byte-equal 镜像**。本地文件和 Chorus draft 字节一致（除了服务端补的尾换行），本地文件是 single source of truth，Chorus 是镜像。
- **人和 agent 在同一份文件上协作**。人在 IDE 里改完保存，agent 下一轮跑 mirror，Chorus 上就跟着更新。反过来 reviewer 在 Chorus 评论里指出某条 requirement 要改，agent 回本地改文件、再 mirror。

为了让新开的 shell 也能找回 change 文件夹，proposal 描述里强制带一行 `OpenSpec change slug: <slug>`。后面 archive 那一步要找 slug，就是 grep 这一行。

---

## 织进 AI-DLC，不需要单独学

桥搭好只是第一步。第二步是把它藏进 AI-DLC 现有的流程里，用户不用专门学 OpenSpec 的命令，也不用记什么时候该走哪条路径。

**SessionStart 自动检测。** 打开一个 session，Claude Code 插件的 hook 顺手查两件事：

1. 仓库根目录有没有 `openspec/`，说明这个项目想用 OpenSpec。
2. `openspec` CLI 在不在 `PATH` 上，说明环境跑得起来。

两个都满足，session 就进入 OpenSpec mode，连接 toast 变成 `(OpenSpec Enabled)`，并往 SessionStart context 里写一行 `CHORUS_OPENSPEC_ACTIVE=1`。少一项，hook 就把原因写清楚，比如目录在但 CLI 没装，toast 会顺手提示 `OpenSpec repo detected — install with: npm i -g @fission-ai/openspec`。两个都没有，老项目走原来的自由 markdown 路径，行为完全不变。

**stage skill 自动切路径。** proposal、develop、yolo 这几个 skill 在写 spec 那一步读 `CHORUS_OPENSPEC_ACTIVE`，等于 1 就跳进 OpenSpec 子流程：起 change 文件夹、按 delta 格式写 spec、走 wrapper mirror；等于 0 就回到原来的自由 markdown。skill 不会重新检测，避免在同一个 session 里来回飘。

**Task 全 verify 完，自动提醒 archive。** OpenSpec 的工作流要求 change 落地后跑一次 `openspec archive <slug>`，把 delta 合进长期 spec，否则下一个 change 写出来就跟前一个接不上。v0.8.0 加了个 PostToolUse hook：每次 task verify 完，hook grep proposal 描述拿 slug，再查这条 idea 下所有 task 是不是都 done 了。是的话，agent 的最终回复里就会自动多一条提醒，让它跑 `openspec archive <slug> -y`，把生成的 `openspec/specs/<capability>/spec.md` mirror 回对应的 Chorus Document（同一个 wrapper，同一条 byte-equal 路径）。

用户这边的负担就两件事：仓库里跑一次 `openspec init`，全局装一次 `@fission-ai/openspec`。剩下的 Claude Code 自己用。想关也容易，`CHORUS_OPENSPEC_MODE=off` 开关一拨，或者从插件 UI 把 `enableOpenSpec` 关掉。

---

## 顺带的几件事

**Windows 跑得起来了。** 之前 `npx @chorus-aidlc/chorus` 在 Windows 上拉到的 tarball 跑不起来，原因是 PGlite 自带的二进制和 npm 打包的路径假设在 Windows 上对不上。这版重写了 `chorus.mjs` 的入口和 prepack 的脚本，发布到 npm 的包在 macOS、Linux、Windows 三套平台上都能直接 `npx` 起来。

**PGlite 模式下的 race。** 多个 Next.js route handler 同时打 PGlite 偶发会撞到同一条连接，因为 PGlite 是 single-writer。这版把 pg.Pool 的 `max` 钉死在 1，用串行换稳定，多 agent 并行情况下不会再炸。

**`chorus_get_my_assignments` 跟 `chorus_checkin` 同一份返回结构。** 之前两个工具的 idea tracker 各算各的，agent 拿到的视图对不上。这版抽了一个 `idea-tracker.service`，两边都用它，看到的是同一份 project-grouped 数据。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

OpenSpec CLI：

```bash
npm install -g @fission-ai/openspec
openspec init   # 在你想用 OpenSpec 的项目里跑一次
```

OpenSpec mode 这版只在 Claude Code 插件里启用，Codex 下一版补。

v0.8.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.8.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.8.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.8.0) | **OpenSpec**: [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)
