#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pnpm --dir "$root" pack --pack-destination "$tmp" >/dev/null
tarball="$(find "$tmp" -maxdepth 1 -name '*.tgz' -print -quit)"
test -n "$tarball"
tar -tzf "$tarball" >"$tmp/files.txt"

for file in package/bin/chorus-mcp-call.mjs package/dist/chorus-dsh.mjs package/dist/index.d.ts package/dist/persona.mjs package/dist/persona.d.ts package/cordis.patch.yml package/README.md; do
  grep -Fx "$file" "$tmp/files.txt" >/dev/null
done
test "$(grep -Ec '^package/skills/[^/]+/SKILL[.]md$' "$tmp/files.txt")" -eq 15

if grep -Eq 'install-dsh|agent-presets|instructions/AGENTS|public/chorus-dsh' "$tmp/files.txt"; then
  echo "legacy installer or copied-home artifact found in tarball" >&2
  exit 1
fi
if tar -xOzf "$tarball" | grep -E 'cho_[A-Za-z0-9_-]{8,}' >/dev/null; then
  echo "credential-like value found in tarball" >&2
  exit 1
fi

echo "chorus-dsh pack validation passed: $(basename "$tarball")"
