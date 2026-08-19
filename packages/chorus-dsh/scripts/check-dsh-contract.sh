#!/usr/bin/env bash
set -euo pipefail

expected="99f6f02fecdb7dff40c3fbc9470f5907c29f74ca"
checkout="${DSH_CHECKOUT:-/home/ubuntu/dev/deepseek-harness}"

if [[ ! -d "$checkout/.git" ]]; then
  echo "missing pinned deepseek-harness checkout: $checkout" >&2
  exit 1
fi

actual="$(git -C "$checkout" rev-parse HEAD)"
if [[ "$actual" != "$expected" ]]; then
  echo "unsupported deepseek-harness revision: expected dsh-v0.1.0-rc.7 ($expected), got $actual" >&2
  exit 1
fi

for contract in \
  "'agent/session-start'" \
  "'agent/pre-step'" \
  "'agent/turn-stopping'"; do
  grep -F "$contract" "$checkout/packages/core/agent/src/runtime-types.ts" >/dev/null
done

grep -F "'tools/post-execute'" "$checkout/packages/core/tools/src/index.ts" >/dev/null
grep -F "'subagent/start'" "$checkout/packages/subagent/subagent/src/lifecycle.ts" >/dev/null
grep -F "'subagent/end'" "$checkout/packages/subagent/subagent/src/lifecycle.ts" >/dev/null

pnpm exec tsc --noEmit
