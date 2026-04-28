---
title: "Chorus v0.6.7: Codex Users, We Got You"
description: "The Chorus plugin was Claude-Code-only. Now Codex CLI gets it too, one command away."
date: 2026-04-28
lang: en
postSlug: chorus-v0.6.7-release
---

# Chorus v0.6.7: Codex Users, We Got You

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.7 is out. One headline change: the Chorus plugin now works on Codex CLI too.

---

## "I'm on Codex — can I still use it?"

From v0.6.0 through v0.6.6, the Chorus plugin was Claude-Code-only. Codex CLI users kept asking, and the answer was always the same: "MCP works, the plugin doesn't."

But MCP just exposes the tools. The thing that actually makes Chorus pleasant is the plugin: it checks in at the right moments, nudges sub-agents to review, follows task state as you move through the flow. When the plugin quietly handles all that in the background, everything feels smooth. Without it, you're stitching the workflow together by hand. Codex users were getting half a product.

v0.6.7 closes that gap.

---

## One command on Codex

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

The installer edits your `~/.codex/config.toml`, wires up MCP and hooks, and drops in 7 workflow skills (chorus/idea/proposal/develop/review/quick-dev/yolo) plus 2 reviewer skills. Run it once. Run it again if you want — it's idempotent. Restart Codex and you're in.

One thing to watch: Codex invokes skills differently than Claude Code. Where you'd type `/chorus:develop` in Claude Code, you type `$develop` in Codex. Same content, different prefix.

If you'd rather click than type commands, the Chorus Install Guide now has a Codex tab sitting between Claude Code and OpenClaw. Copy key, run installer, test connection — three steps.

---

## Also in this release

- **Workspace picker**: When one email belongs to multiple Companies, the login flow lets you pick which workspace to enter. No more juggling accounts.
- **Logout no longer signs you out of the IdP**: Clearing the local session is enough. The IdP SSO session stays, so the next login can go silent.
- **Better connect docs**: New `CONNECT_CLAUDE_CODE` / `CONNECT_CODEX` / `CONNECT_OTHER_AGENTS` guides (en + zh) walk through each client path end to end.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

Codex CLI plugin:

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

v0.6.7 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.7) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.7](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.7)
