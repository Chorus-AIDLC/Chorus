---
title: "Writing the Same Plugin Twice: Claude Code vs Codex"
description: "Built one plugin for Claude Code, one for Codex CLI. Same logic. Wildly different experience."
date: 2026-05-03
lang: en
postSlug: claude-code-vs-codex-plugin-systems
---

# Writing the Same Plugin Twice: Claude Code vs Codex

While building the CLI plugins for [Chorus](https://github.com/Chorus-AIDLC/Chorus), I wrote one for Claude Code and one for Codex CLI. Same logic on both sides. The effort was not remotely comparable.

On paper, both CLIs offer the same toolbox: plugins, hooks, MCP, subagents. In practice, the two implementations diverge sharply as soon as you try to ship anything non-trivial. This post grades them on 9 dimensions (0-5), from the perspective of a plugin developer. What can you actually build on each side, and where do you hit the wall?

> Versions: Claude Code `2.1.126`, Codex CLI `0.128.0`. Both are moving fast, so some of what I complain about here may already be fixed by the time you read this.

I've written about the Claude Code side in detail before: [Building a Claude Code plugin for Agent Teams](/blog/building-claude-code-plugin-for-agent-teams). This post focuses on what went wrong on the Codex side, and what that means for plugin developers.

---

## 1. How far does "install" take you

From the user's point of view: they hear about Chorus, they want their CLI to be able to call Chorus tools. How many steps between those two points?

Claude Code: two slash commands inside the TUI.

```
/plugin marketplace add Chorus-AIDLC/Chorus
/plugin install chorus@chorus-plugins
```

The plugin ships its own `.mcp.json` pointing at the Chorus MCP server, with `${CHORUS_URL}` and `${CHORUS_API_KEY}` as environment variable placeholders. The user exports two vars in their shell, restarts Claude Code, and every `chorus_*` tool shows up.

Codex is also inside the TUI, but **there is no equivalent `/plugin install` slash command**. The official path is opening the `/plugins` panel, arrowing down to the plugin, and pressing Install. For a plugin developer this means you cannot give your users a "copy these two lines" install path. At minimum they have to drive a UI once.

I didn't accept that. I wrote a Bash installer that does the work:

1. Register the marketplace
2. Prompt for `CHORUS_URL` and `CHORUS_API_KEY`
3. Write the MCP config into `~/.codex/config.toml`
4. **The critical trick**: directly write `[plugins."chorus@chorus-plugins"] enabled = true` into config.toml, bypassing the TUI so Codex treats the plugin as enabled on next launch
5. Install the hooks into the user's global config (more on that next section)
6. Flip `[features] codex_hooks = true`

From the user's side it feels like `curl | bash` and done, similar to Claude Code. The cost is that I'm hacking around Codex from the outside, and the script is brittle. The moment Codex changes the semantics of `[plugins."xxx"] enabled = true` in any release, I have to rewrite it.

There are also plenty of little things like this: the script has to work under macOS's stock Bash 3.2. No associative arrays, no `${VAR,,}`, no `mapfile`. Both Claude Code and Codex launch hooks through the system bash, and on macOS that's 3.2.

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 2. Shipping an MCP server inside the plugin

This is the most painful part of the whole Codex experience.

A bit of context: everything Chorus agents touch goes through MCP tools. Installing the plugin should equal installing MCP, without making the user edit config files by hand.

Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "chorus": {
      "type": "http",
      "url": "${CHORUS_URL}/api/mcp",
      "headers": { "Authorization": "Bearer ${CHORUS_API_KEY}" }
    }
  }
}
```

At runtime the harness substitutes `${CHORUS_URL}` and `${CHORUS_API_KEY}` with the environment values. The plugin declares this one file and the harness handles the rest.

Same approach does not work on Codex, for two reasons.

First, **nothing in Codex's `~/.codex/config.toml` gets expanded. Every field is a literal string**. Write `url = "${CHORUS_URL}"` and Codex will literally send a request to the string `${CHORUS_URL}`.

Second, HTTP MCP auth gives you exactly two options:

```toml
# Option A: have Codex read from an environment variable
bearer_token_env_var = "CHORUS_API_KEY"

# Option B: bake the literal token into the plugin
[mcp_servers.chorus.http_headers]
Authorization = "Bearer cho_xxxxxxx"
```

Option A looks clean. But on macOS, if the user launches Codex from Launchpad or the Dock, **it will not see environment variables exported in your shell rc**. For most real users this path is simply broken.

Option B would require the plugin to ship with the user's token in plaintext. Obviously not happening.

So I ripped MCP out of the plugin entirely. The installer writes `[mcp_servers.chorus]` into the user's `config.toml` at runtime, using awk to make the write idempotent (if you run it again, the old block gets replaced wholesale), and `chmod 600` because the file now contains a plaintext token. In other words, **the `mcpServers` field in a Codex plugin manifest is essentially useless for HTTP MCP**. You go around the harness and edit config files yourself.

I get the design intent. Codex wants config files without plaintext secrets, pushing secrets into the environment. That's a fine goal. But it assumes the user's shell env is a reliable channel, and macOS GUI launch breaks that assumption cleanly. Until Codex adds `${VAR}` expansion or gives plugins a way to declare "prompt the user for a secret at runtime," HTTP MCP plugin distribution will keep looking like this: half manifest, half side-script.

**Claude Code: 5 / 5 · Codex: 1 / 5**

---

## 3. Can hooks ship with the plugin

This one burned an entire day of testing, reading source, and searching issues.

The scenario is straightforward. The Chorus plugin needs three hooks: on session start, call `chorus_checkin` to inject the agent's identity and pending work into context; when the agent submits a proposal, trigger a reviewer; when it submits a task, trigger another reviewer. These hooks should obviously ship with the plugin.

Claude Code treats it as obvious. Drop `hooks/hooks.json` into the plugin, use `${CLAUDE_PLUGIN_ROOT}` to point at your own scripts, and the harness registers them when the plugin loads. Done.

Codex: I did the same thing. Added a `hooks.json` to the plugin, pointed the manifest's `hooks` field at it. I was modeling this on the official Codex plugin examples, which literally ship a `hooks.json` in the plugin root. After install, the `/plugins` panel showed the hooks as present. But on session start the hooks simply **did not fire**.

My first instinct was that I had written them wrong. To sanity-check the JSON itself, I copied it verbatim to `~/.codex/hooks.json`. It worked immediately. So it had to be something on the plugin side.

That kicked off the classic self-doubt loop. I tried different command forms (absolute paths, relative paths, simple `echo` scripts), changed matchers, reinstalled the plugin repeatedly, bumped versions, experimented with variations of the `hooks` field, diffed my manifest against the example directory line by line. Each round failed, each time I assumed the mistake was mine. Most of a day went by.

Eventually, out of ideas, I searched the Codex repo for issues. [#16430](https://github.com/openai/codex/issues/16430): another developer hitting the exact same wall. The issue lays out the truth: the plugin manifest parser only recognizes `skills` / `mcpServers` / `apps`, not `hooks`; hook discovery only scans `hooks.json` under the config layer, never inside installed plugins. The capability the manifest schema and example directory imply simply does not exist in this version. Issue still open.

Reading that, the real outrage landed: **the official docs say nothing, at all, about whether a plugin's `hooks.json` is loaded**. I had reverse-engineered "it should work" from the manifest schema and the example layout. The truth is it doesn't. My entire afternoon of self-doubt was spent debugging a feature that isn't implemented.

Bottom line: Codex plugins can contribute skills and MCP, but **they cannot actually deliver hooks**. Plugin developers either give up on hooks, or install them into the user's global `~/.codex/hooks.json` by hand.

I went with the second. The installer writes the hooks into the user's global file, plus an extra wrapper script to paper over the fact that the plugin cache path changes on every version bump. It works, but it's fragile. If the user edits that file manually, or installs another plugin that also writes hooks, or uninstalls Chorus without cleaning up, any of those breaks things. On Claude Code, all of this is managed by the harness and the plugin developer never has to think about it.

**Claude Code: 5 / 5 · Codex: 0 / 5**

---

## 4. Are the hook events enough

One of Chorus's features is observability across parallel agent work: when five subagents are writing code in parallel, the kanban should show who is on which task, how far they've gotten, and whether they're still alive. That translates, in plugin terms, to: the harness must expose the full agent lifecycle as hook events.

Claude Code's hook event list is thorough:

| Event | What Chorus uses it for |
|---|---|
| `SessionStart` | Call `chorus_checkin`, inject identity and pending work into context |
| `UserPromptSubmit` | Lightweight status reminders (no network calls) |
| `PreToolUse:Task` | Capture the subagent's name, write to `.chorus/pending/<name>` |
| `SubagentStart` | **Core**: create or reuse a session, inject the UUID and workflow into the subagent |
| `TeammateIdle` | Send a session heartbeat to keep it alive |
| `TaskCompleted` | Auto-checkout by task tag |
| `SubagentStop` | Close the session, fetch newly-unblocked downstream tasks and surface them to the Team Lead |
| `SessionEnd` | Clean up `.chorus/` |

The most important one is `SubagentStart`: before the subagent actually starts working, the plugin can create the session and inject the UUID directly into its context. Observability becomes something the harness guarantees, rather than something the agent has to remember to report via MCP.

Codex has six hooks total: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`. **Nothing about agent lifecycle**.

The consequences go deeper than they sound:

- Once the main agent calls `spawn_agent`, the subagent is invisible to the plugin. No automatic session creation, no automatic task checkin, no heartbeats, no automatic checkout.
- The only workaround is making the main agent **remind itself** in its prompt. My `$yolo` skill is full of discipline like "before spawning, call `chorus_create_session`; pass `sessionUuid` into the subagent's initial prompt; when it finishes, remember both `close_agent` and `chorus_close_session`." LLMs follow it most of the time. They skip a step occasionally, and you get a leaked session hanging around.
- I originally used `UserPromptSubmit` for lightweight status reminders, then killed it. Codex's TUI echoes the hook's `additionalContext` into the status area with a `hook context:` prefix, so every user message floods the screen. Noisier than useful. It's a case of a harness UI choice directly undermining a hook's utility.

Automatic session tracking: not achievable on Codex.

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 5. Are subagents first-class

Chorus has two reviewer agents. One reviews proposals after submission, another reviews tasks after submission. Both must be **read-only** (no Edit, Write, or Bash), and their output must end with exactly one of `VERDICT: PASS / PASS WITH NOTES / FAIL`.

On Claude Code this is a standard feature. Drop `agents/proposal-reviewer.md` into the plugin:

```yaml
---
description: "Review submitted Chorus proposals for quality"
model: inherit
maxTurns: 20
disallowedTools: [Agent, Edit, Write, NotebookEdit, Bash]
---
```

The body of the file is the reviewer's system prompt. The main agent calls `Task(subagent_type: "chorus:proposal-reviewer")` and it's off. Tool permissions, model selection, turn limits, all enforced at the harness level.

On Codex it's harder. `spawn_agent` accepts four built-in roles and only those four: `default`, `explorer`, `worker`, `awaiter`. **The plugin manifest has no field for registering new roles**. I initially assumed `agents/openai.yaml` under a skill directory might register a role. `spawn_agent(agent_type="chorus-proposal-reviewer")` responded with `unknown agent_type`. After digging through the docs and the Rust source, I confirmed `openai.yaml` is purely metadata for the TUI `/plugins` panel.

The workaround: treat the reviewer as a skill, spawn with the built-in `default` role, and stuff the skill content through the `items` array.

```
spawn_agent(
  agent_type="default",
  items=[
    { type: "skill", path: "chorus:chorus-proposal-reviewer" },
    { type: "text",  text: "Review proposal <uuid>. Post VERDICT." }
  ]
)
```

Functional, but three things are lost:

1. **Tool permission isolation**. It's a `default` role, so the subagent can do anything. I have to put "do not modify any files, do not run Bash" in SKILL.md and trust the LLM. There have been incidents where a reviewer helpfully "fixed" code it was supposed to review.
2. **Turn caps**. No harness field for this. Best I can do is "turn budget rule: when ≤3 turns remain, post your review immediately" in the prompt.
3. **Structured output enforcement**. The main agent matches the verdict with a strict regex `^VERDICT: (PASS|PASS WITH NOTES|FAIL)$`. LLMs love inventing synonyms like "APPROVE," "OK," "✅." I hammer on the three-literal rule in SKILL.md and in the hook-injected additional context, then the main agent treats any unmatched output as FAIL.

There's also a Codex-specific landmine: **a root thread can have at most 6 concurrent subagents, and `completed` status does not free a slot**. You must explicitly `close_agent(id)`. A long chain like `$yolo`, which spawns multiple reviewers and workers in sequence, hits `agent thread limit reached` on the seventh spawn. Every `spawn_agent` has to be paired with a `close_agent`, and that discipline goes into the skill body for the LLM to remember.

To summarize: what Claude Code guarantees at the harness level is a prompt-engineering project on Codex.

**Claude Code: 5 / 5 · Codex: 2 / 5**

---

## 6. Skills

The one section where Codex holds its ground.

Both sides work similarly: a `SKILL.md` file with frontmatter for metadata, body for agent-facing instructions. Both support namespacing (`chorus:develop`). Both allow user-initiated and model-initiated invocation.

The difference is in frontmatter richness. Claude Code skills can configure `allowed-tools`, `context: fork` (run the skill in a fresh context), `disable-model-invocation` (user-only trigger), and `model`. Codex's frontmatter has fewer knobs but covers the basics.

Porting Chorus's 7 skills from Claude Code to Codex took a day. Three mechanical changes:

1. Trigger syntax `/chorus:develop` → `$chorus:develop`
2. Every mention of the `Task` tool in the body → `spawn_agent`
3. Sections that relied on hooks auto-spawning reviewers → advisory context the main agent spawns explicitly

**Claude Code: 5 / 5 · Codex: 4 / 5**

---

## 7. Can you put variables in config

From a plugin developer's angle, this determines whether you can actually "write once, run everywhere."

Claude Code gives you two kinds of variable:

- `${CLAUDE_PLUGIN_ROOT}`: expands to the plugin install path in hook config
- `${VAR}`: expands to environment variables in MCP config

Hook subprocesses also inherit the shell env. Plugin authors basically don't think about paths or secrets.

Codex piles three limitations on top of each other:

- `~/.codex/config.toml` expands nothing. Every field is a literal string.
- `~/.codex/hooks.json` requires absolute paths in `command`. No `${CODEX_PLUGIN_DIR}` or equivalent.
- The plugin cache path includes a semver (`$CODEX_HOME/plugins/cache/chorus-plugins/chorus/<semver>/`), which changes on every version bump.

Combined, they mean the harness offers no stable reference to "the plugin install path." A plugin author either rewrites `hooks.json` on every upgrade, or (like me) adds another layer of indirection outside the harness.

On Claude Code this is zero lines of code. On Codex it's a block of logic in the Bash installer plus a permanent wrapper script.

**Claude Code: 5 / 5 · Codex: 1 / 5**

---

## 8. Marketplace

Both are JSON manifests in a GitHub repo.

Claude Code's `.claude-plugin/marketplace.json` lets `source` point at a path inside the repo, another GitHub repo, or any Git URL. `/plugin marketplace update` picks up changes.

Codex's `.agents/plugins/marketplace.json` adds two policy categories: `installation` with three tiers (`AVAILABLE` / `INSTALLED_BY_DEFAULT` / `NOT_AVAILABLE`) and `authentication` with two (`ON_INSTALL` / `ON_USE`). The semantics are actually tidier than Claude Code's, thought through more carefully. I used `INSTALLED_BY_DEFAULT` to compensate for the missing install command, so the plugin auto-loads on first launch.

Both formats are sufficient. The difference is ecosystem: Claude Code already has a batch of third-party plugins in the wild; the Codex side is mostly official skill samples, with little public prior art to reference.

**Claude Code: 4 / 5 · Codex: 3 / 5**

---

## 9. Documentation and debugging

**"I wrote what the docs said but the harness doesn't accept it"** — this is the dimension that hurts the most when writing plugins.

Behind Codex's painful debugging experience from section 3, there's a surprising upside: **the source code is fully open**. When the docs fall short, you can just open the repo and read the Rust. A lot of my assertions in this post — `spawn_agent` only accepts four built-in roles, `config.toml` does not expand variables, `completed` subagents don't free thread slots — I felt confident stating them because I'd read them in `codex-rs/`. Docs may lag, but truth is always readable.

Claude Code is the inverse. The docs are genuinely good — hook event fields, `additionalContext` injection targets, MCP variable expansion rules, the plugin layout — all clearly explained. But the source is not open, and behaviors the docs don't cover used to require guessing and trial-and-error. Lucky for us, Claude Code recently had an "open-source moment," and community copies of the source are now floating around. Many previously guessable details can now be verified. Between the official docs and this "accidentally readable" code, debugging Claude Code has actually gone from fuzzy to clear.

On documentation and openness, each side wins half. Claude Code has cleaner docs, Codex has always-readable source. When you're actually writing a plugin, the two resources are complementary.

**Claude Code: 4 / 5 · Codex: 4 / 5**

---

## Scorecard

| Dimension | Claude Code | Codex |
|---|---:|---:|
| Install | 5 | 2 |
| MCP integration | 5 | 1 |
| Hook delivery | 5 | 0 |
| Hook event coverage | 5 | 2 |
| Subagents | 5 | 2 |
| Skills | 5 | 4 |
| Config variables | 5 | 1 |
| Marketplace | 4 | 3 |
| Docs and debugging | 4 | 4 |
| **Total** | **43 / 45** | **19 / 45** |

---

## Summary

Claude Code's plugin system is designed with **multi-agent collaboration as a first-class concern**: `SubagentStart` injects into the subagent, `TeammateIdle` keeps sessions alive with heartbeats, frontmatter `disallowedTools` is a harness-level constraint. These are infrastructure for plugin developers. You build complex coordination on top without reinventing the primitives.

Codex's plugin system is early. The three extension points (plugins, hooks, MCP) exist, but the pieces that actually support real multi-agent coordination are missing. Hook delivery broken, only four built-in subagent roles, no variable expansion, lifecycle events absent — each is a few hundred lines of Rust on its own. Together they produce the current state: a lot of things you cannot do, and the things you can do come packaged with a Bash installer.

If you're considering writing a CLI plugin:

1. **Pure MCP integration**: Claude Code, install-and-go. Codex, bring an installer script.
2. **Depends on multi-agent observability** (session lifecycle, heartbeats, task orchestration): Not doable on Codex right now.
3. **Pure skill bundle**: Comparable on both sides.
4. **Needs isolated read-only subagents** (reviewers, auditors): Claude Code's `agents/*.md` frontmatter nails it. On Codex you're stuck with prompt-level discipline. Don't expect the harness to enforce permission isolation.
