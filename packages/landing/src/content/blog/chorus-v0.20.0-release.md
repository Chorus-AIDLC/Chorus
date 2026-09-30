---
title: "Chorus v0.20.0: Protocol Upgrades for Three Agent Backends"
description: "What changes when a headless agent gets a two-way protocol connection? A look at Codex App Server, Claude Code stream-json, and Pi RPC."
date: 2026-09-30
lang: en
postSlug: chorus-v0.20.0-release
---

# Chorus v0.20.0: Protocol Upgrades for Three Agent Backends

Launching a CLI, sending a prompt, and reading its output is a straightforward way to run an agent from a background service. The Chorus daemon used this approach too. Sending interruptions and answering permission requests during execution, however, calls for a richer interface.

Chorus v0.20.0 moves three backends to Codex App Server, bidirectional Claude Code stream-json, and native Pi RPC, giving the daemon protocol-level control over execution.

## From one-time input to two-way communication

The previous backends already supported JSON event streams and session resumption. They shared an input pattern: write a prompt to stdin, close it, then read stdout until the process exits. Interruptions relied on operating-system signals and process cleanup.

The new backends keep stdin open for protocol messages during execution. Stdout carries execution events, responses, and requests sent back to the daemon.

| Agent | Previous launch mode | Launch mode in v0.20.0 |
| --- | --- | --- |
| Codex | `codex exec --json`, or `exec resume` for existing sessions | `codex app-server --listen stdio://` |
| Claude Code | `claude -p --output-format stream-json` | Adds `--input-format stream-json` for protocol messages in both directions |
| Pi | `pi --mode json --session-id <id> -p` | `pi --mode rpc --session-id <id>` |

Permission, working-directory, and other options are omitted here. All three still run **headlessly**, with a separate process for each wake and persisted sessions carrying context between runs.

## Codex: from exec to App Server

With `codex exec --json`, a CLI invocation handled an entire run: accept a prompt, emit events, and exit. App Server exposes separate session and execution operations, letting the daemon choose which session to resume, when to start a turn, and when to interrupt it.

The server is a local child process communicating over standard input and output. It does not need a network port. The daemon initializes the connection, creates or resumes a session, and submits the task. Codex streams back messages, tool activity, and status.

The protocol separates request responses from execution outcomes. An interruption acknowledgment means Codex has handled the request; the daemon still waits for the turn to end before recording it as interrupted. This gives it more explicit execution state than process signals alone.

The session is also established and its ID saved before execution starts, so even an interrupted first turn has a known resumption target. Sessions created by the previous `exec` backend remain usable.

## Claude Code: stream-json in both directions

Claude Code still starts with `claude -p`. Previously, only its output used stream-json. Adding `--input-format stream-json` makes the input a structured message channel that stays available throughout the run.

Stream-json sends one JSON message per line. The daemon submits the prompt, then keeps the channel open to send interruptions or answer permission requests. Execution output and control requests share the output stream, where the daemon handles them separately.

This fills in the interaction needed during a background run. Interruptions use protocol messages, and tools outside the allowed scope receive an explicit denial and reason in Chorus restricted mode. Questions for a person go through Chorus comments or elaboration, avoiding a wait for terminal input.

Session handling continues to use `--session-id` and `--resume`.

## Pi: from JSON output to native RPC

Pi moves from `--mode json -p` to `--mode rpc`. The previous mode accepted a single prompt and emitted execution events. RPC lets the daemon keep sending commands during a run, including state queries, task submission, and interruption.

RPC stands for remote procedure call, but this connection also uses a local process's standard input and output. The daemon sends commands; Pi returns responses while reporting progress. A command response and a completed task are separate events.

A Pi run can include automatic retries or context compaction. The daemon waits for those to settle before closing the process. It also tracks interruptions separately, so a normal process exit does not turn an interrupted task into a successful one.

Extension dialogs, such as selection, confirmation, or text input, also reach the daemon through RPC. Chorus cancels these terminal interactions so background work does not get stuck waiting for input. Existing sessions can still resume; if history cannot be restored, the conversation shows a notice that a new session has started.

## What the three backends have in common

Each backend retains its own protocol and permission model. All three now let the daemon communicate with the agent during execution and distinguish a request response, a finished run, and a restored session.

If a protocol interruption exceeds the existing grace period, the daemon still forces process cleanup. New messages received during execution remain queued for later turns.

## Upgrading and compatibility

Pi requires **0.85.0 or newer**. Live Linux verification covered Pi **0.85.1**, Codex **0.157.1**, and Claude Code **2.1.283 / 2.1.284**. Earlier Codex versions have not been verified.

v0.20.0 also adds `chorus upgrade`, aliased as `chorus update`, for npm-global CLI installations. To upgrade from an older version:

```bash
npm install -g @chorus-aidlc/chorus@0.20.0
chorus upgrade --plugins
chorus daemon restart
```

`--plugins` refreshes Claude Code, Codex, Kiro, and Pi integrations registered in the default daemon configuration. Update the agent CLIs separately. Kiro templates come from the connected Chorus server, so update that server first if you use Kiro.
