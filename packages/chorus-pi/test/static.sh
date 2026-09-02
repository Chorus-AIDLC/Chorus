#!/usr/bin/env bash
# Static validation for chorus-pi. No runtime deps. Run: bash test/static.sh
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "═══ A1. TS transpile + extensions/ dir hygiene ═══"
bun build --no-bundle extensions/chorus.ts --outfile /tmp/chorus-pi-check.js >/dev/null 2>&1 && ok "chorus.ts transpiles" || no "chorus.ts transpile failed"
rm -f /tmp/chorus-pi-check.js
# Every .ts directly in extensions/ is auto-loaded by pi as an extension and MUST
# export a default factory. Helper modules must live OUTSIDE extensions/ (we use lib/).
# Guard: any non-default-exporting .ts in extensions/ would crash pi on load.
ext_ts=$(ls extensions/*.ts 2>/dev/null)
if [ -n "$ext_ts" ]; then
  for f in $ext_ts; do
    if bun -e "import m from './$f'; console.log(typeof m)" 2>/dev/null | grep -q '^function$\|^async function$'; then
      ok "$(basename $f) exports a default factory"
    else
      no "$(basename $f) in extensions/ has no valid default factory — pi will fail to load it (move helpers to lib/!)"
    fi
  done
fi

echo "═══ A1b. no undefined module-scope variables (catches the callSessions bug) ═══"
# A transpile (bun build) does NOT catch references to undeclared variables because
# TS strips types and bun's transpiler is lenient. So grep for the known module-scope
# consts and assert every reference is preceded by a declaration.
for v in callSessions injectedOnce checkinContext mcpSessionId; do
  decls=$(grep -cE "^const $v\b|^let $v\b" extensions/chorus.ts)
  uses=$(grep -cE "\b$v\b" extensions/chorus.ts)
  if [ "$decls" -ge 1 ]; then ok "$v declared ($decls×) and used ($uses×)"; else no "$v used ($uses×) but NEVER declared — runtime ReferenceError"; fi
done
echo "═══ A2. package.json + pi manifest ═══"
bun -e 'const p=require("./package.json");
 const errs=[];
 if(!Array.isArray(p.pi?.extensions))errs.push("pi.extensions not array");
 if(!Array.isArray(p.pi?.skills))errs.push("pi.skills not array");
 if(!p.bin?.["chorus-mcp-call"])errs.push("bin.chorus-mcp-call missing");
 // The reviewer subagents now use pi'"'"'s OFFICIAL subagent pattern bundled at
 // extensions/subagent/ — the third-party @narumitw/pi-subagents dep MUST be gone.
 for(const b of ["dependencies","devDependencies","peerDependencies","optionalDependencies"])
   if(p[b]?.["@narumitw/pi-subagents"])errs.push("@narumitw/pi-subagents must be removed from "+b);
 if(errs.length){console.log(errs.join("; "));process.exit(1)}' 2>&1 && ok "package.json pi manifest valid" || no "package.json invalid"

echo "═══ A3. skill frontmatter (name+description, Agent Skills name rules) ═══"
for s in skills/*/SKILL.md; do
  name=$(grep -m1 "^name:" "$s" | sed 's/^name:[[:space:]]*//; s/[[:space:]]*$//')
  desc=$(grep -m1 "^description:" "$s" | sed 's/^description:[[:space:]]*//')
  [ -n "$name" ] && [ -n "$desc" ] || { no "$s: missing name/description"; continue; }
  # name rules: lowercase a-z0-9, hyphens ok, no leading/trailing/double hyphen
  if echo "$name" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then ok "$s name='$name'"; else no "$s name='$name' violates rules"; fi
done

echo "═══ A4. agent frontmatter (name+description; reviewers read-only tools) ═══"
for a in agents/*.md; do
  name=$(grep -m1 "^name:" "$a" | sed 's/^name:[[:space:]]*//')
  desc=$(grep -m1 "^description:" "$a" | sed 's/^description:[[:space:]]*//')
  tools=$(grep -m1 "^tools:" "$a" | sed 's/^tools:[[:space:]]*//')
  [ -n "$name" ] && [ -n "$desc" ] || { no "$a missing name/description"; continue; }
  case "$name" in
    *-reviewer)
      # reviewers MUST declare an explicit tools list AND be read-only (no write/edit)
      if [ -z "$tools" ]; then no "$a reviewer missing tools (must be an explicit read-only list)"; continue; fi
      if echo "$tools" | grep -qiE '\b(write|edit|replace|undo)\b'; then
        no "$a reviewer has write tools (should be read-only)"
      else
        ok "$a reviewer name='$name' tools='$tools'"
      fi
      ;;
    *)
      # worker/implementer agents intentionally OMIT tools so they inherit the
      # dispatcher's full capabilities (write/edit/bash/mcp). name+description suffice.
      ok "$a name='$name' tools='${tools:-<inherit full>}'"
      ;;
  esac
done

echo "═══ A5. wrapper bash syntax ═══"
bash -n bin/chorus-mcp-call.sh && ok "chorus-mcp-call.sh syntax" || no "wrapper syntax"

echo "═══ A6. no Claude/Codex product residual ═══"
if grep -rnE "Claude Code|CLAUDE_PROJECT|CLAUDE_PLUGIN|\.claude/|Codex specifics|\.codex/plugins|PLUGIN_ROOT|subagent_type|run_in_background|TeamCreate|SendMessage|\bTask\(\{|Agent\(\{" skills/ agents/ bin/ 2>/dev/null | grep -vE "chorus_[a-z_]+\(" | grep -q .; then
  no "residual Claude/Codex refs found:"; grep -rnE "Claude Code|CLAUDE_PROJECT|CLAUDE_PLUGIN|\.claude/|Codex specifics|\.codex/plugins|PLUGIN_ROOT|subagent_type|run_in_background|TeamCreate|SendMessage|\bTask\(\{|Agent\(\{" skills/ agents/ bin/ | grep -vE "chorus_[a-z_]+\(" | sed 's/^/    /'
else ok "no Claude/Codex product residual"
fi

echo "═══ A7. skill cross-refs (/skill:X map to real skills) ═══"
declared=$(for s in skills/*/SKILL.md; do grep -m1 "^name:" "$s" | sed 's/^name:[[:space:]]*//'; done | sort -u)
for ref in $(grep -rhoE "/skill:[a-z0-9-]+" skills/ | sort -u | sed 's|/skill:||'); do
  echo "$declared" | grep -qx "$ref" && ok "/skill:$ref -> skill exists" || no "/skill:$ref -> NO matching skill"
done

echo "═══ A8. agent cross-refs (skills spawn agents that exist) ═══"
agent_names=$(for a in agents/*.md; do grep -m1 "^name:" "$a" | sed 's/^name:[[:space:]]*//'; done | sort -u)
# pi official subagent example agents: scout, planner, reviewer, worker (shipped in
# pi's examples/extensions/subagent/agents/; referenced by our orchestration skills)
builtins="scout planner reviewer worker"
for ref in $(grep -rhoE 'agent: "[a-z0-9-]+"' skills/ | sed 's/agent: "//; s/"//' | sort -u); do
  if echo " $builtins " | grep -q " $ref "; then ok "spawn '$ref' -> pi subagent example agent";
  elif echo "$agent_names" | grep -qx "$ref"; then ok "spawn '$ref' -> agent exists";
  else no "spawn '$ref' -> NO matching agent or built-in"; fi
done

echo ""
echo "═══ RESULT: $pass passed, $fail failed ═══"
exit $fail
