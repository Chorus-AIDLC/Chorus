---
title: "Chorus v0.14.0: Chorus goes dark"
description: "别的工具都能调暗，就 Chorus 一屏白，晚上盯着看 Agent 干活费眼睛。这一版它也黑得下来了。"
date: 2026-07-11
lang: zh
postSlug: chorus-v0.14.0-release
---

# Chorus v0.14.0: Chorus goes dark

别的工具都能调暗，就 [Chorus](https://github.com/Chorus-AIDLC/Chorus) 一屏白，晚上盯着看 Agent 干活费眼睛。v0.14.0 支持深色模式了，开关在侧边栏底部，浅色、深色、跟随系统三档，每台设备各记各的。

![Chorus 深色模式下的项目总览：左侧想法列表，右侧想法详情面板，整屏沉下来](/images/dark-mode.png)

---

## 又多了两门语言

界面全是英文，对不少人是道坎。看得懂，但总隔着一层。

v0.14.0 加了韩语和日语，连上原本的中英文，现在四门。第一次打开会按浏览器语言自动选，是 `ja` 就给你日语，之后跟你手动切的走。

韩语是社区贡献的，[moduvoice](https://github.com/Chorus-AIDLC/Chorus/pull/411) 提了 PR 把整个应用翻了过去。非常感谢他给 Chorus 带来了韩文版。

## 把参考资料带进工作流

干活的时候手边总有一堆外部资料。一份接口文档、一个拿来参考的仓库、某个 issue 里的讨论、一篇讲清楚了某个坑的博客。这些以前在 Chorus 里没地方放，你只能贴进评论，或者记在别处，回头再翻。

这是社区在 [issue #399](https://github.com/Chorus-AIDLC/Chorus/issues/399) 里提的需求。v0.14.0 让想法、提案、任务都能挂参考资料，就放在这条工作本身待的地方，随时翻回来看。想法列表里每条还标着底下挂了几份。Agent 也能通过 MCP 工具自己添、自己读，它查到的资料不会跟着一次对话结束就丢。

---

上一篇讲思维导图的 0.13.0 之后，0.13.1、0.13.2 两个版本没单独写，这里把攒下的几件事一并补上。

## 想法可以先归归类了

项目一大，想法就杂，一堆平铺着，看不出哪些是围着同一个方向的。这一版加了「主题」：一种只做归类的想法，把相关的几条想法收在同一个大方向下。它不自己出提案，真正的活还是在派生出的子想法里写；它能细化，给子想法当共享的背景。

## daemon 的几处增强

- **从 UI 直接派活**：想法详情页多了「开始开发」和「Yolo」两个按钮。前者把想法推进到开发阶段、唤醒 Agent 接手，后者把整条想法从头到尾交给 Agent 跑完，不用回命令行。
- **对话式建想法**：新建想法的弹窗多了对话模式，不用先憋出一段规整描述，直接跟 Agent 聊，想法、对应的会话、第一条指令一次建好。
- **崩了能接着跑**：远程 Agent 中途崩了，对话窗口和连接面板会给一个「继续」，带着崩溃说明重新唤醒，接着上次的地方跑，Claude Code 和 Codex 都支持。
- **停机不再留假在线**：以前关 daemon 有时没断干净，进程走了服务端还显示在线。现在退出时如实上报结果，服务端也会接管已死 daemon 手里悬着没跑完的执行。还多了个 `chorus daemon install`，把 daemon 装成后台常驻服务，开机自起、崩了自动拉起。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

升完在侧边栏底部就能看到主题开关，跟语言选择并在一起。

v0.14.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.14.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.14.0)
