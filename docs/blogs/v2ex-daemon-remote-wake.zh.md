# 我是怎么让远端的 Claude Code 自己接任务、把活干了的

先看效果。在网页上把一条想法派给远端某台机器的某个目录，那边的 Claude Code 自己就醒了，接活、开干。我没在 prompt 里写一个字告诉它要做什么，那些它自己查出来的，全程我没碰终端：

![远程唤醒 Claude Code](https://chorus-ai.dev/images/agent-daemon-wake.gif)

我做了几个月一个开源项目 [Chorus](https://github.com/Chorus-AIDLC/Chorus)，简单说就是给 Claude Code 配了个带网页的任务后台：想法、提案、任务这一整条开发流程在服务端管着，Claude Code 在本地领活、干活、交活。

但有个尴尬一直没解决：那半个 AI 平时根本不在线。我把任务派给一个 agent，它不会自己动，得等我哪天打开终端、跑起 Claude Code、把它领下来，才动一下。最近做的这个 daemon 就是来填这个坑的，让本地的 Claude Code 能自己接住服务端派来的任务。下面说说这套「派过去它自己就开干」的链路是怎么搭起来的。

## 唤醒：订阅通知，spawn 一个 headless claude

唤醒这步其实最简单。daemon 起来后订阅服务端的通知流（SSE），有任务派给这个 agent，就在本地 spawn 一个 headless 的 `claude -p` 去干。

实现上有个选择：要不要接 Anthropic 的 Agent SDK。我选了直接 spawn 子进程。理由很现实，Chorus 要发到 npm，得在 linux、macOS、Windows 上都能跑，SDK 会拖进一串依赖，子进程这边零新增依赖。prompt 走 stdin 不走命令行参数，省掉转义和长度的麻烦，Windows 上自己找 `claude.cmd`。本地既然装了 Claude Code，直接调就完事了。

## 醒来怎么知道干啥：给它一个认得路的环境

唤醒不难，难的是它醒来得知道自己要干嘛。

设想用 cron 唤起一个 `claude -p`，你得在 prompt 里贴上：任务描述、之前聊需求定下的几条结论、它依赖的前置任务上线了没、验收标准是什么。漏一条它就跑偏。而这堆东西你从哪复制？多半还是从你自己脑子里。喂少了它瞎做，喂多了你又退化成在工具之间搬运文本的人肉 adapter。

Chorus 这边这些上下文本来就在库里。任务挂在哪条想法下、需求细化时聊出了什么结论、上游验收了没、AC 是什么，全是结构化存着的。所以唤起 claude 的时候，prompt 里只塞一个想法的 uuid 当线头，真正给它的是一套能去查这些的工具：daemon spawn claude 时带上 `--mcp-config`，指向 Chorus 的 MCP server（一个写在临时目录、用完即删的小 JSON，里面是服务端地址加这个 agent 的 key），claude 一起来就带着 `chorus_*` 这套工具。它进来先 `chorus_get_task` 看自己被派了啥，翻 elaboration 记录搞清楚为什么这么做，干完直接提交验收。

它能自己接任务往前推、不用我一句句喂，靠的就是这个——醒在一个它认得路的环境里，而不是醒在一段干巴巴的 prompt 前。

## 同一条想法，是同一场对话

每次唤醒要是各干各的，agent 跨任务就失忆了。所以每个 session 锚在它对应那条想法的 uuid 上（没有归属想法的活，比如一个快速任务，就锚在它自己的 uuid 上）：同一条想法下的活，唤起的是同一个 session，`--resume` 接着上次往下走；想法和想法之间，session 互相隔开。

这么锚还顺带解决了一件事，就是人能随时插回来。每次唤醒的日志里都打一句 `claude --resume <idea-uuid>`，你在 daemon 的工作目录里跑这句，就直接进到 agent 刚才那场对话里，不用翻 transcript 找会话 ID。它干到一半我想自己接手，跳进去就行。背后有个队列按锚点排，保证同一个 session 不会被两次唤醒同时 resume 撞上。

## 后台跑的东西，得看得见也插得进话

agent 在后台自己接任务跑，最怕变黑盒，连上没、在忙啥、干到哪，一概不知道。所以 transcript 通过 SSE 实时推到前端，每个 turn 它说了什么、跑了什么命令都看得到。

光看还不够，跑偏了得能拦。我做了条反向的控制通道，服务端可以给 daemon 发不触发唤醒的控制信号。基于它做了三件事：你能在网页上给正在跑的 agent 插一句话，作为它的下一个 turn；能打断一个跑歪的 turn，daemon 收到信号会把那个 headless claude 的进程树两阶段干掉，先 SIGINT 留一截宽限窗口、不退再 SIGKILL；打断之后状态停在那，等你点恢复再 resume 接着原来那场往下续。能看、能拦、能插话，丢后台才放心。

## 一个 daemon 守多个目录，还得能精确叫醒

最新这版修的是我自己撞上的坑。daemon 守一个目录，可我代码散在好几个仓库里，前端一个后端一个。在前端目录起的 daemon，后端任务派过来，它就在前端目录里跑错了地方。

于是让一个 daemon 能同时守多个目录（`--cwd` 可以重复传），每个目录是条独立连接，每个 `(agent、主机、目录)` 做成能单独点名的实例，派任务、@ 它的时候挑具体哪个。这里还有个不太起眼的坑：原来的唤醒是朝这个 agent 名下所有连接广播一个事件，钉了后端那个目录，前端那个也照样收到，谁先 resume 上算谁的。所以带钉的唤醒改成了定向投递，只发给算出来的那一个连接。钉哪个，就只醒哪个。

## 小结

整套链路拆开看就这么几样：订阅通知、spawn 一个 headless 子进程、给它一个能自查上下文的 MCP 环境、加一条反向控制通道，没给项目新增任何 npm 依赖。代码不复杂，真正费工夫的是边界：唤醒进哪个上下文、session 怎么锚、跑偏了怎么拦、多目录怎么不串。说到底想要的就一句话，把任务派过去，远端那个 Claude Code 自己就接着干了，不用我守在终端前。

后来把 `--agent` 这个预留点兑现了，现在 `--agent codex` 能让本地 Codex 接活。Codex 跟 Claude Code 不太一样：它自己生成会话 id 不收外部指定的，所以每条想法的会话 id 我单独缓存了一份，下次唤醒拿它 `codex exec resume` 续上；没有 `--mcp-config` 这种东西，MCP 走它自己的 `~/.codex/config.toml`，daemon 只把自己的 key 通过环境变量喂进去；权限那边它是 sandbox 模式，yolo 就直接 `--dangerously-bypass-approvals-and-sandbox`。新唤醒、续会话、打断这几样都通了，打断复用的还是同一套进程组 kill。transcript 上传暂时只有 Claude Code 那条做了，Codex 的留到后面；模型认证（Bedrock 或 `codex login`）得你自己先配好。开源，AGPL-3.0，Next.js + Prisma + PostgreSQL，项目本身就是用 Chorus + Claude Code 开发的。

- GitHub: https://github.com/Chorus-AIDLC/Chorus
- v0.12.0 详细博文: https://chorus-ai.dev/zh/blog/chorus-v0.12.0-release/

有问题欢迎 Issues 或 Discussions。
