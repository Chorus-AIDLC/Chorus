#!/usr/bin/env bash
set -euo pipefail

# Verify chorus-dsh's runtime contract holds against upstream dsh: the lifecycle
# events + tool/subagent hooks the bundle depends on must still EXIST in the dsh
# source. We deliberately DO NOT pin an exact dsh revision — chorus-dsh supports a
# range of dsh versions, so this checks the contract survives, not that dsh is one
# specific commit. Override the ref (branch or tag) with DSH_CONTRACT_REF to
# validate the contract against any dsh version; DSH_CHECKOUT points at a local
# checkout to skip the clone.
ref="${DSH_CONTRACT_REF:-dsh-v0.1.2-rc.1}"
checkout="${DSH_CHECKOUT:-}"
temporary_checkout=""

if [[ -z "$checkout" ]]; then
  temporary_checkout="$(mktemp -d)"
  trap 'rm -rf "$temporary_checkout"' EXIT
  checkout="$temporary_checkout/deepseek-harness"
  git clone --quiet --depth 1 --branch "$ref" \
    https://github.com/deepseek-ai/deepseek-harness.git "$checkout"
fi

if [[ ! -d "$checkout/.git" ]]; then
  echo "missing deepseek-harness checkout: $checkout" >&2
  exit 1
fi

echo "checking chorus-dsh contract against deepseek-harness $(git -C "$checkout" rev-parse --short HEAD) (ref: $ref)" >&2

# The real contract: the events chorus-dsh's lifecycle plugin observes must exist.
# A grep miss = the contract broke on this dsh version (regardless of revision).
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
