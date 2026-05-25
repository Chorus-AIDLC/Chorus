# session-lifecycle-active-only

Refactor AgentSession lifecycle to active/closed only; replace inactive concept with lastActiveAt query filter; bake heartbeat into all session-touching MCP tools
