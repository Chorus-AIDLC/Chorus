---
title: "Chorus v0.20.0：三种 Agent 唤醒后端的协议升级"
description: "同样是 headless 运行，执行一次命令和建立双向协议连接有什么区别？从 Codex App Server、Claude Code stream-json 和 Pi RPC 看这次后端升级。"
date: 2026-09-30
lang: zh
postSlug: chorus-v0.20.0-release
---

# Chorus v0.20.0：三种 Agent 唤醒后端的协议升级

启动 CLI、送入 prompt、读取输出，是把 Agent 接入后台服务的直接方式。Chorus 的 daemon 之前也这样工作，但要在执行中发送中断、回应权限请求，还需要更完整的通信接口。

Chorus v0.20.0 将三个后端迁移到 Codex App Server、Claude Code 双向 stream-json 和 Pi 原生 RPC，通过协议控制任务的执行过程。

## 从一次性输入，到双向通信

旧实现已经支持 JSON 事件流和会话恢复。共同点在输入端：向 stdin 写入一次 prompt 后关闭输入，随后读取 stdout，等待进程退出；中断通过操作系统信号和进程清理完成。

新实现保持 stdin 打开，运行中仍可发送协议消息。stdout 则同时承载执行事件、响应和反向控制请求。

| Agent | 原来的启动方式 | v0.20.0 的启动方式 |
| --- | --- | --- |
| Codex | `codex exec --json`，恢复时使用 `exec resume` | `codex app-server --listen stdio://` |
| Claude Code | `claude -p --output-format stream-json` | 增加 `--input-format stream-json`，输入输出均使用协议消息 |
| Pi | `pi --mode json --session-id <id> -p` | `pi --mode rpc --session-id <id>` |

表中省略了权限、工作目录等参数。三种方式仍是 **headless 运行**，每次唤醒启动独立进程，通过持久化会话衔接上下文。

## Codex：从 exec 命令转向 App Server

原来的 `codex exec --json` 把一次执行封装在 CLI 命令里：传入 prompt，读取事件，等待结束。App Server 则提供独立的会话和执行接口，让 daemon 分别控制“恢复哪个会话”“开始哪一轮任务”和“何时中断”。

这里的 Server 是一个本地子进程，通过标准输入输出通信，无需监听网络端口。daemon 先完成初始化，再创建或恢复会话、提交任务；Codex 在执行过程中持续返回消息、工具调用和状态。

这套协议把请求响应与执行结果分开。例如，中断请求得到响应，只说明 Codex 已处理这个请求；daemon 还会等待当前轮次结束，再记录为已中断。相比依赖进程信号，这种方式能更明确地判断任务状态。

会话也在执行前建立并保存，因此首次任务被中断后仍有恢复目标。旧 `exec` 模式创建的会话可以继续使用。

## Claude Code：从单向输出转向双向 stream-json

Claude Code 仍通过 `claude -p` 启动。原来只有输出采用 stream-json，新版增加 `--input-format stream-json`，让输入也成为持续可用的结构化消息通道。

stream-json 可以理解为逐行传递 JSON 消息。daemon 先发送 prompt，随后保持输入通道打开，用同一条连接发送中断或回答权限请求。Claude Code 的执行输出和控制请求也从同一条输出流返回，由 daemon 分别处理。

这次改动主要补齐了运行中的交互：中断走协议消息；在 Chorus 受限模式下，超出允许范围的工具请求会收到明确拒绝和原因。需要人回答的问题则通过 Chorus 评论或需求澄清提出，避免后台任务等待终端输入。

会话恢复方式保持不变，继续使用 `--session-id` 和 `--resume`。

## Pi：从 JSON 输出模式转向原生 RPC

Pi 从 `--mode json -p` 改为 `--mode rpc`。旧模式接收一次 prompt 后输出执行事件；RPC 模式允许 daemon 在运行期间继续发送命令，例如查询状态、提交任务和中断执行。

RPC 是远程过程调用的接口形式，这里同样通过本地进程的标准输入输出通信。daemon 发送命令，Pi 返回响应，同时上报执行进度。收到命令响应和任务执行完成，是两个不同的时刻。

Pi 的一次执行还可能包含自动重试或上下文压缩。daemon 会等这些处理结束后再关闭进程，并单独保留中断状态，避免将进程正常退出误记为任务正常完成。

扩展弹出的选择、确认或输入对话框，也通过 RPC 交给 daemon。Chorus 会取消这些需要终端交互的对话框，避免后台运行卡在等待输入上。旧会话仍可恢复；历史无法恢复时，对话中会提示已经开启新会话。

## 共同变化：运行过程可以被明确控制

三个后端仍然使用各自的协议和权限模型，但 daemon 都能在任务运行期间与 Agent 双向通信，分别判断请求是否得到响应、执行是否结束，以及会话是否恢复。

协议中断超时后，daemon 仍会强制清理进程。执行期间收到的新消息继续排队，留待后续轮次处理。

## 升级与兼容性

Pi 需要 **0.85.0+**。Linux 实机验证覆盖 Pi **0.85.1**、Codex **0.157.1**、Claude Code **2.1.283 / 2.1.284**；更早的 Codex 版本尚未验证。

v0.20.0 新增 `chorus upgrade`（别名 `chorus update`），支持 npm 全局安装的 CLI 自升级。从旧版首次升级：

```bash
npm install -g @chorus-aidlc/chorus@0.20.0
chorus upgrade --plugins
chorus daemon restart
```

`--plugins` 刷新默认 daemon 配置中登记的 Claude Code、Codex、Kiro 和 Pi 集成，Agent CLI 需另行升级。Kiro 模板来自 Chorus 服务，使用 Kiro 时先更新服务端。
