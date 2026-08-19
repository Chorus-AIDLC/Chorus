#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${DSH_CHECKOUT:-/home/ubuntu/dev/deepseek-harness}"
expected="99f6f02fecdb7dff40c3fbc9470f5907c29f74ca"
test_file="$checkout/apps/cli/tests/chorus-npm-bundle.smoke.spec.ts"
tmp="$(mktemp -d)"

cleanup() {
  rm -f "$test_file"
  rm -rf "$tmp"
}
trap cleanup EXIT

test "$(git -C "$checkout" rev-parse HEAD)" = "$expected"
mkdir -p "$tmp/pack" "$tmp/home"
pnpm --dir "$root" pack --pack-destination "$tmp/pack" >/dev/null
tarball="$(find "$tmp/pack" -maxdepth 1 -name '*.tgz' -print -quit)"

# rc.7 creates each profile as a one-package pnpm workspace. pnpm 9 requires
# this explicit forward-compatible flag when adding to that workspace root.
DSH_HOME="$tmp/home" node "$checkout/apps/cli/lib/bin.js" \
  plugin --profile web add --ignore-workspace-root-check "$tarball"
printf '[]\n' >"$tmp/home/profiles/web/cordis.yml"

cp "$root/tests/dsh-smoke.e2e.ts" "$test_file"
CHORUS_DSH_SMOKE_HOME="$tmp/home" \
CHORUS_URL="http://127.0.0.1:1" \
CHORUS_API_KEY="cho_smoke_only" \
CHORUS_DAEMON_HEADLESS="1" \
pnpm --dir "$checkout" exec vitest run \
  apps/cli/tests/chorus-npm-bundle.smoke.spec.ts
