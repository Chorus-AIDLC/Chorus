# Connect Other AI Agents to Chorus

For agents **other than Claude Code and Codex** — any MCP-capable client such as Cursor, Continue, a custom agent, or a hand-rolled integration — the fastest path is to let the agent itself install and configure Chorus using a natural-language prompt. You hand it the Chorus URL + API Key and point it at the skill doc; it handles the rest.

> For Claude Code, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md). For Codex, see [CONNECT_CODEX.md](CONNECT_CODEX.md). Both have official plugins that give you more than the raw MCP tools (hooks, skills, slash commands).

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- An AI agent that supports MCP servers (HTTP streamable transport or equivalent)
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## The install prompt

Copy the prompt below and send it to your agent. Replace `CHORUS_URL` and `API_KEY` with your real values first.

```text
Please install and configure the Chorus AI-DLC collaboration platform.

Chorus URL: http://localhost:8637
API Key: cho_your_api_key

Read the setup instructions from:
http://localhost:8637/skill/chorus/SKILL.md

Follow the "Setup" section to configure the MCP server,
then call chorus_checkin() to verify the connection.
```

The Web UI's setup wizard (**Settings → Setup Guide → Open setup guide → Other Agents** tab) renders this same prompt with your actual `CHORUS_URL` and API key already filled in — so you can copy-paste directly instead of editing values by hand.

## What the agent will do

The skill doc at `/skill/chorus/SKILL.md` describes how to register Chorus as an MCP server in the agent's config. The exact mechanism depends on the client:

- **Cursor / Continue / Zed**: add an entry under their `mcpServers` config (JSON or settings UI).
- **Custom agent using `@modelcontextprotocol/sdk`**: open an HTTP streamable transport to `CHORUS_URL/api/mcp` with `Authorization: Bearer <API_KEY>`.
- **OpenAI Agents SDK / LangChain / etc.**: wire Chorus as an MCP tool source and pass the same URL + header.

All of them converge on the same two pieces of config:

| Field | Value |
|-------|-------|
| MCP server URL | `{CHORUS_URL}/api/mcp` |
| Auth header | `Authorization: Bearer {API_KEY}` |

The agent should then call `chorus_checkin` — if that returns your agent's identity and permissions, you're connected.

## Verification

Ask the agent:

```text
check in to chorus
```

You should see a JSON response describing the agent, its permissions, and recent Chorus activity. If the agent can also list the available MCP tools (e.g. `chorus_pm_create_idea`, `chorus_claim_task`), the connection is fully working.

## Troubleshooting

- **Agent says "no MCP server named chorus"** — It didn't persist the config. Ask it to show you the MCP config file it wrote to, then verify the entry is there.
- **`401 Unauthorized`** — API key wrong or revoked. Recreate under Settings → Agents and resend the prompt with the new key.
- **`404` from `/api/mcp`** — URL likely missing `/api/mcp` or pointing at the wrong host. Test with `curl -H "Authorization: Bearer $CHORUS_API_KEY" "$CHORUS_URL/api/mcp"` — you should get a JSON error response (not a network error).
- **Agent calls tools but doesn't follow the AI-DLC workflow** — Point it at the full skill doc at `/skill/chorus/SKILL.md`; the `Setup` section is just the minimum. The workflow sections (`Idea`, `Proposal`, `Develop`, `Review`) describe how to actually use the tools together.

## Next

- Skill reference: `http://localhost:8637/skill/chorus/SKILL.md` (served from your Chorus instance)
- Full MCP tool reference: [MCP_TOOLS.md](MCP_TOOLS.md)
- To connect Claude Code instead, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md)
- To connect Codex instead, see [CONNECT_CODEX.md](CONNECT_CODEX.md)
