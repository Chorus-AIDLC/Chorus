#!/usr/bin/env bash
set -euo pipefail

expected="a66e4702047846cdaa10c66c9d3df3951f5ea70d"
tag="dsh-v0.1.2-rc.1"
checkout="${DSH_CHECKOUT:-}"
temporary_checkout=""

if [[ -z "$checkout" ]]; then
  temporary_checkout="$(mktemp -d)"
  trap 'rm -rf "$temporary_checkout"' EXIT
  checkout="$temporary_checkout/deepseek-harness"
  git clone --quiet --depth 1 --branch "$tag" \
    https://github.com/deepseek-ai/deepseek-harness.git "$checkout"
fi

if [[ ! -d "$checkout/.git" ]]; then
  echo "missing pinned deepseek-harness checkout: $checkout" >&2
  exit 1
fi

actual="$(git -C "$checkout" rev-parse HEAD)"
if [[ "$actual" != "$expected" ]]; then
  echo "unsupported deepseek-harness revision: expected $tag ($expected), got $actual" >&2
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
