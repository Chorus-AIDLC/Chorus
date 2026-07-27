#!/usr/bin/env bash
# precheck.sh — run in a plain shell BEFORE launching the new Pi session.
# Verifies install, env, MCP config, agent files, and tool-name prefix are all
# in place so the in-session verification (verify-pi-session.md) can succeed.
#
# Usage:  bash chorus-pi/test/precheck.sh
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "═══ P1. env vars ═══"
[ -n "${CHORUS_URL:-}" ] && ok "CHORUS_URL set ($CHORUS_URL)" || no "CHORUS_URL not set — export CHORUS_URL=http://localhost:8637"
[ -n "${CHORUS_API_KEY:-}" ] && ok "CHORUS_API_KEY set (cho_…${CHORUS_API_KEY: -4})" || no "CHORUS_API_KEY not set"

echo "═══ P2. Chorus reachable ═══"
url="${CHORUS_URL:-http://localhost:8637}"
url="${url%/}"
url="${url%/api/mcp}"
if curl -s -o /dev/null -m 5 "$url" 2>/dev/null; then ok "Chorus root reachable ($url)"; else no "Chorus root not reachable ($url) — start it (pnpm dev) or fix CHORUS_URL"; fi

echo "═══ P3. runtime deps installed ═══"
[ -d ~/.pi/agent/npm/node_modules/pi-mcp-adapter ] && ok "pi-mcp-adapter installed" || no "pi-mcp-adapter missing — pi install npm:pi-mcp-adapter"
[ -d ~/.pi/agent/npm/node_modules/@narumitw/pi-subagents ] && ok "pi-subagents installed" || no "pi-subagents missing — pi install npm:@narumitw/pi-subagents"

echo "═══ P4. chorus-pi installed (or at least present) ═══"
# It may be installed as a local path; just check the package dir is valid and pi can load it.
if [ -f package.json ] && grep -q '"pi"' package.json; then ok "chorus-pi package present (./chorus-pi)"; else no "run from chorus-pi/ or check package.json"; fi

echo "═══ P5. MCP config (.mcp.json) ═══"
found_mcp=""
# .mcp.json lives at the repo root (parent of chorus-pi/), or globally under ~/.pi/agent/
for c in ../.mcp.json ~/.pi/agent/mcp.json; do
  if [ -f "$c" ] && grep -q '"chorus"' "$c"; then found_mcp="$c"; fi
done
[ -n "$found_mcp" ] && ok "chorus MCP server declared in $found_mcp" || no "no .mcp.json / ~/.pi/agent/mcp.json with a 'chorus' server — pi-mcp-adapter won't expose chorus_* tools"

echo "═══ P6. reviewer agents on discovery path ═══"
acount=$(ls ~/.pi/agent/agents/chorus-*-reviewer.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$acount" = "3" ]; then ok "3 reviewer agents in ~/.pi/agent/agents/"; else
  no "only $acount reviewer agents in ~/.pi/agent/agents/ (expected 3)"
  echo "    fix: cp agents/*.md ~/.pi/agent/agents/"
fi

echo "═══ P7. tool-name prefix (the critical porting gotcha) ═══"
echo "  pi-mcp-adapter prefixes MCP tool names with the server name by default"
echo "  (toolPrefix='server'). Your chorus server is named 'chorus', and the"
echo "  backend tools are already named 'chorus_checkin', so the LLM-facing"
echo "  tool name in gateway mode is 'chorus_chorus_checkin' (double prefix)."
echo "  The skill docs teach 'chorus_checkin' (the backend native name)."
echo ""
echo "  Determine which mode this session uses by checking the system prompt's"
echo "  tool list (in-session): if you see 'mcp' as a single gateway tool, it's"
echo "  GATEWAY mode (call via mcp({tool:'chorus_chorus_checkin'})); if you see"
echo "  individual 'chorus_*' tools, it's DIRECT mode (call 'chorus_checkin')."
echo "  → The in-session verification below checks both and reports which works."

echo ""
echo "═══ RESULT: $pass passed, $fail failed ═══"
echo ""
echo "If all passed, launch a FRESH pi session (do not --resume) and follow"
echo "the in-session steps in test/verify-pi-session.md (paste them to the agent)."
exit $fail
