#!/usr/bin/env bash
# Pack @chorus-aidlc/chorus-pi into a throwaway dir and assert the tarball holds
# exactly the runtime assets — the extension, lib, all skills, all 3 reviewer
# agents, the bin wrapper, and README — and NONE of test/, node_modules/, .env,
# or credential-like (cho_…) strings. Modeled on the dsh package's check-pack.sh
# (but chorus-pi ships TypeScript source, not a dist/ build).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pnpm --dir "$root" pack --pack-destination "$tmp" >/dev/null
tarball="$(find "$tmp" -maxdepth 1 -name '*.tgz' -print -quit)"
test -n "$tarball"
tar -tzf "$tarball" >"$tmp/files.txt"

# ─── Required runtime assets present ────────────────────────────────────────
for file in \
  package/extensions/chorus.ts \
  package/extensions/subagent/index.ts \
  package/extensions/subagent/agents.ts \
  package/lib/lib.ts \
  package/bin/chorus-mcp-call.sh \
  package/agents/chorus-code-reviewer.md \
  package/agents/chorus-proposal-reviewer.md \
  package/agents/chorus-task-reviewer.md \
  package/README.md; do
  if ! grep -Fx "$file" "$tmp/files.txt" >/dev/null; then
    echo "missing required file in tarball: $file" >&2
    exit 1
  fi
done

skill_count="$(grep -Ec '^package/skills/[^/]+/SKILL[.]md$' "$tmp/files.txt")"
if [ "$skill_count" -ne 12 ]; then
  echo "expected 12 skills in tarball, found $skill_count" >&2
  exit 1
fi

# ─── Forbidden artifacts absent ─────────────────────────────────────────────
if grep -Eq '^package/(test|tests|node_modules|scripts)/' "$tmp/files.txt"; then
  echo "forbidden dir (test/tests/node_modules/scripts) found in tarball" >&2
  grep -E '^package/(test|tests|node_modules|scripts)/' "$tmp/files.txt" >&2
  exit 1
fi
if grep -Eq '(^|/)\.env$' "$tmp/files.txt"; then
  echo ".env found in tarball" >&2
  exit 1
fi

# Credential scan: extract every cho_ token from the tarball CONTENT and fail if
# any real key survives. The lone documented placeholder (`cho_your_key`, in the
# chorus skill doc) is allowlisted so it does not trip the check; any other
# cho_… token (a real key is base64url, far longer) is a hard failure.
if tar -xOzf "$tarball" \
  | grep -Eo 'cho_[A-Za-z0-9_-]{8,}' \
  | grep -vxE 'cho_your_key' \
  | grep -q .; then
  echo "credential-like value found in tarball" >&2
  exit 1
fi

echo "chorus-pi pack validation passed: $(basename "$tarball") ($skill_count skills)"
