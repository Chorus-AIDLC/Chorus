---
title: "Chorus v0.6.6: npx 一键启动"
description: "Docker 都不用装了。一行 npx 本地跑 Chorus，文档还能导出带走。"
date: 2026-04-23
lang: zh
postSlug: chorus-v0.6.6-release
---

# Chorus v0.6.6: npx 一键启动

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.6 来了。这个版本做了两件事：npm 一键安装本地运行，文档支持导出带走。

---

## 安装劝退了多少人

你跟同事安利 Chorus，对方说"行，我试试"。然后你开始解释：先装 Docker，拉镜像，配 compose，跑起来之后还要配环境变量……

对方还没打开终端，兴趣已经凉了一半。

v0.6.2 加了 PGlite 内嵌数据库，Redis 也换成了内存事件总线自动降级，三个容器缩到一个。但"装 Docker"这个前置条件还在。对于只想快速看一眼 Chorus 长什么样的人来说，Docker 本身就是门槛。

---

## 现在 npx 就够了

```bash
npx @chorus-aidlc/chorus
```

不用装 Docker，不用配数据库，不用写 docker-compose.yml。npx 拉包，PGlite 内嵌 PostgreSQL，自动跑 migration，打开浏览器就能用。

能做到这一点，是因为 Chorus 全栈基于 WASM 和纯 JS，不依赖任何原生 C/C++ 模块。macOS ARM、Linux x86/ARM 都能直接跑，不跟编译环境较劲。

正式用的话，Docker Compose 依然是推荐的生产部署方式，独立 PostgreSQL + Redis 更适合多 Agent 并发。但"先跑起来看看"这件事，不应该需要任何前置准备。

---

## 社区要的：把文档带出去

[Issue #195](https://github.com/Chorus-AIDLC/Chorus/issues/195#issuecomment-4286676685) 里 @songyitao1991 提了一个很实际的场景：

> 项目交付必然有与客户确认的环节，需要有一份阶段性的 PRD 和技术文档。Chorus 能够利用 AI 进行规范完整的开发，但不能很好地服务于项目交付，不能阶段性地形成传统的文档性资料与客户进行沟通确认。

说得对。AI 生成的文档如果只能在 Chorus 里看，那它就是个封闭系统的中间产物，不是可交付的资产。

v0.6.6 加了文档导出，三种格式：

- **Markdown**：带 YAML frontmatter，可以直接丢进任何文档系统
- **PDF**：内置 CJK + emoji 字体，Mermaid 图表渲染成 PNG，开箱即用
- **Word**：代码块带语法高亮，方便不习惯 Markdown 的人阅读

在文档详情页、文档列表页、Proposal 编辑页都能导出。Proposal 里的文档草稿也能在审批前导出预览，不用等审批通过才能拿到内容。

---

## 其他改动

- **Proposal 撤回**：审批通过的 Proposal 现在可以撤回。发现代码写歪了也不用着急，撤回 Proposal 改完再来。撤回会级联关闭已创建的 Task、删除已生成的 Document，状态回到草稿。操作前有影响预览，不会误触。
- **Checkin API 重构**：Agent 上线一秒获悉工作全貌，按项目分组的 Idea 追踪器、未读通知摘要一次返回，直接接上之前的工作。
- **Onboarding 优化**：复制 API Key、安装插件、测试连接三步都可以返回上一步了。等待 Agent 连接不再有 5 分钟超时，SSE 会一直监听。等待页面还加了可复制的 checkin prompt，新人不用翻文档找命令。
- **完成后自动提醒 Review**：Sub-agent 完成 Task 后会自动收到 Review + Verify 提醒，不再需要人工提醒它提交验证。

---

## 升级

npm 用户：
```bash
npx @chorus-aidlc/chorus@latest
# 或全局安装
npm install -g @chorus-aidlc/chorus
```

Docker 用户：
```bash
docker compose up -d --pull always
```

别忘了同步更新 Chorus Plugin，新版本的 Onboarding 流程和 Review 提醒都依赖插件更新：

```bash
# Claude Code 内执行
/plugin marketplace update chorus-plugins
```

v0.6.6 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.6) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.6](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.6)
