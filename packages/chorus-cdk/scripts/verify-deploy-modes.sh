#!/usr/bin/env bash
#
# Verify both deployment modes (`alb` and `cloudfront`) WITHOUT deploying.
#
#   pnpm -C packages/chorus-cdk run verify:modes
#
# What it does:
#   1. `cdk synth` the stack in alb mode, cloudfront mode (custom domain +
#      us-east-1 certificate) and cloudfront mode (no domain, no certificate),
#      then assert on the emitted templates (scripts/assert-deploy-modes.mjs).
#   2. Assert the certificate-region and domain/certificate pairing errors fail
#      synth with the expected message.
#   3. Synth alb mode from the pre-change commit with identical context and
#      compare resource sets and logical IDs — an upgraded stack must see no
#      resource replacement.
#   4. Drive install.sh non-interactively per mode with an overridden config
#      path and the dry-run switch, and assert the generated deployment config.
#
# Requirements: node, pnpm, the AWS CLI with working credentials (install.sh
# checks them), and this package's node_modules installed. Nothing is deployed:
# no `cdk bootstrap`, no `cdk deploy`, no live AWS mutation. The only AWS call
# is install.sh's own `aws sts get-caller-identity`.
#
# Environment:
#   CHORUS_VERIFY_BASELINE_REF   git ref to diff alb mode against (default below)
#   CHORUS_VERIFY_KEEP=1         keep the scratch directory for inspection
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${CDK_DIR}/../.." && pwd)"

# The commit this branch forked from — the last `develop` state before the
# CloudFront deploy-mode change. The alb-mode template must be byte-identical to
# this commit's, logical IDs included. Once this change is merged the default is
# still valid (it is an ancestor of develop); to re-baseline against a newer
# pre-change commit, pass CHORUS_VERIFY_BASELINE_REF. The script refuses a
# baseline that already knows `deployMode`.
BASELINE_REF="${CHORUS_VERIFY_BASELINE_REF:-243ba34a}"

STACK_NAME="Chorus"
ADMIN_EMAIL="verify@example.com"
ADMIN_PASSWORD="verify-password"
# Region is pinned so the run is deterministic wherever it happens: alb mode's
# certificate check compares against the ambient region, so an inherited
# AWS_REGION would otherwise decide whether the alb-mode synth passes or fails.
VERIFY_REGION="${CHORUS_VERIFY_REGION:-us-east-1}"
export AWS_REGION="${VERIFY_REGION}"
export AWS_DEFAULT_REGION="${VERIFY_REGION}"

# Fixed so the templates are comparable run to run. All are syntactically valid
# and belong to no real account — nothing is ever deployed with them.
ALB_CERT_REGION="${VERIFY_REGION}"
ALB_CERT="arn:aws:acm:${ALB_CERT_REGION}:111122223333:certificate/aaaa"
CF_CERT="arn:aws:acm:us-east-1:111122223333:certificate/bbbb"
# Deliberately neither the deploy region nor us-east-1, so it is wrong in both modes.
FOREIGN_REGION="eu-west-1"
if [ "${VERIFY_REGION}" = "${FOREIGN_REGION}" ]; then FOREIGN_REGION="us-west-2"; fi
FOREIGN_CERT="arn:aws:acm:${FOREIGN_REGION}:111122223333:certificate/cccc"
CF_DOMAIN="chorus.example.com"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/chorus-verify-modes.XXXXXX")"
TPL="${WORK}/templates"
mkdir -p "${TPL}"
cleanup() {
  if [ -n "${CHORUS_VERIFY_KEEP:-}" ]; then
    echo "Scratch directory kept at ${WORK}"
  else
    rm -rf "${WORK}"
  fi
}
trap cleanup EXIT

FAILS=0
ok() { # ok <name> <0|1 as exit status of a test> [detail]
  local name="$1" status="$2" detail="${3:-}"
  if [ "$status" -eq 0 ]; then
    echo "PASS  ${name}${detail:+ :: $detail}"
  else
    FAILS=$((FAILS + 1))
    echo "FAIL  ${name}${detail:+ :: $detail}"
  fi
}
section() { echo; echo "=== $* ==="; }

# ──────────────────────────────────────────────
# 1. Synthesize the three templates from the working tree
# ──────────────────────────────────────────────

# The CDK CLI always injects CDK_DEFAULT_REGION (falling back to us-east-1), so
# alb mode's own-region certificate check is always active under `cdk synth`.
synth() { # synth <name> <cdk dir> <extra -c args...>
  local name="$1" dir="$2"
  shift 2
  ( cd "$dir" && npx cdk synth --no-notices --output "${WORK}/out-${name}" \
      -c "stackName=${STACK_NAME}" \
      -c "superAdminEmail=${ADMIN_EMAIL}" \
      -c "superAdminPassword=${ADMIN_PASSWORD}" \
      "$@" ) >"${WORK}/${name}.log" 2>&1
}

section "Synthesizing templates (no deployment)"
for spec in \
  "alb|-c deployMode=alb|-c acmCertificateArn=${ALB_CERT}" \
  "cf-domain|-c deployMode=cloudfront|-c acmCertificateArn=${CF_CERT}|-c customDomain=${CF_DOMAIN}" \
  "cf-nocert|-c deployMode=cloudfront"
do
  name="${spec%%|*}"
  args="${spec#*|}"
  # shellcheck disable=SC2086 # deliberate word splitting of the -c pairs
  synth "$name" "$CDK_DIR" ${args//|/ }
  status=$?
  ok "synth ${name} succeeds" "$status" "$( [ $status -ne 0 ] && tail -3 "${WORK}/${name}.log" | tr '\n' ' ' )"
  if [ $status -ne 0 ]; then
    echo "Cannot continue without a template for ${name}." >&2
    exit 1
  fi
  cp "${WORK}/out-${name}/${STACK_NAME}.template.json" "${TPL}/${name}.json"
done

# The default (no deployMode at all) must resolve to alb: same shape, no CloudFront.
synth default-mode "$CDK_DIR" -c "acmCertificateArn=${ALB_CERT}"
ok "synth with no deployMode at all succeeds (defaults to alb)" $?
if grep -q 'AWS::CloudFront' "${WORK}/out-default-mode/${STACK_NAME}.template.json" 2>/dev/null; then
  ok "default mode emits no CloudFront resources" 1
else
  ok "default mode emits no CloudFront resources" 0
fi

# ──────────────────────────────────────────────
# 2. Baseline synth for the backwards-compatibility diff
# ──────────────────────────────────────────────
section "Synthesizing alb mode from the pre-change commit ${BASELINE_REF}"
BASE_TREE="${WORK}/baseline"
mkdir -p "${BASE_TREE}"
if ! git -C "${REPO_ROOT}" archive "${BASELINE_REF}" | tar -x -C "${BASE_TREE}"; then
  echo "Could not export ${BASELINE_REF}; is it a valid git ref?" >&2
  exit 1
fi
# Reuse the installed dependencies rather than a second pnpm install: the CDK
# library version is what matters and it is pinned by this package.
ln -s "${CDK_DIR}/node_modules" "${BASE_TREE}/packages/chorus-cdk/node_modules"
synth baseline "${BASE_TREE}/packages/chorus-cdk" -c deployMode=alb -c "acmCertificateArn=${ALB_CERT}"
status=$?
ok "baseline synth succeeds" "$status" "$( [ $status -ne 0 ] && tail -3 "${WORK}/baseline.log" | tr '\n' ' ' )"
if [ $status -ne 0 ]; then
  echo "Cannot continue without a baseline template." >&2
  exit 1
fi
cp "${WORK}/out-baseline/${STACK_NAME}.template.json" "${TPL}/baseline.json"
# Sanity: the baseline really predates the change (it must reject deployMode
# silently rather than branch on it) — it has no CloudFront support at all.
if grep -q 'deployMode' "${BASE_TREE}/packages/chorus-cdk/bin/chorus.ts"; then
  ok "baseline ref predates the deployMode change" 1 "${BASELINE_REF} already knows deployMode"
else
  ok "baseline ref predates the deployMode change" 0 "${BASELINE_REF}"
fi

# ──────────────────────────────────────────────
# 3. Template assertions
# ──────────────────────────────────────────────
section "Template assertions"
VERIFY_ALB_CERT_REGION="${ALB_CERT_REGION}" \
VERIFY_CF_CERT_ARN="${CF_CERT}" \
VERIFY_CF_DOMAIN="${CF_DOMAIN}" \
  node "${SCRIPT_DIR}/assert-deploy-modes.mjs" "${TPL}"
ok "all template assertions pass" $?

# ──────────────────────────────────────────────
# 4. Expected synth failures
# ──────────────────────────────────────────────
expect_synth_error() { # expect_synth_error <name> <expected substring> <extra -c args...>
  local name="$1" expected="$2"
  shift 2
  synth "$name" "$CDK_DIR" "$@"
  local status=$?
  if [ $status -eq 0 ]; then
    ok "${name}: synth fails" 1 "synth unexpectedly succeeded"
    return
  fi
  if grep -qF "$expected" "${WORK}/${name}.log"; then
    ok "${name}: fails with the expected error" 0 "\"${expected}\""
  else
    ok "${name}: fails with the expected error" 1 "expected \"${expected}\", got: $(grep -m1 '^Error' "${WORK}/${name}.log")"
  fi
}

section "Expected certificate / mode errors"
expect_synth_error err-cf-wrong-region \
  "CloudFront alternate domain names require a certificate from us-east-1" \
  -c deployMode=cloudfront -c "acmCertificateArn=${FOREIGN_CERT}" -c "customDomain=${CF_DOMAIN}"
expect_synth_error err-alb-foreign-region \
  "An ALB listener requires a certificate from its own region" \
  -c deployMode=alb -c "acmCertificateArn=${FOREIGN_CERT}"
expect_synth_error err-cf-domain-no-cert \
  "must be supplied together in cloudfront mode" \
  -c deployMode=cloudfront -c "customDomain=${CF_DOMAIN}"
expect_synth_error err-alb-no-cert \
  "acmCertificateArn is required" \
  -c deployMode=alb
expect_synth_error err-unknown-mode \
  "is not supported" \
  -c deployMode=cloudfrunt -c "acmCertificateArn=${ALB_CERT}"

# ──────────────────────────────────────────────
# 5. install.sh non-interactive dry runs
# ──────────────────────────────────────────────
section "install.sh non-interactive dry runs"

REAL_PNPM="$(command -v pnpm || true)"
if [ -z "${REAL_PNPM}" ]; then
  echo "pnpm is required on PATH for the installer dry run." >&2
  exit 1
fi

# Two stubs. `forward` logs and then runs the real pnpm, so install.sh behaves
# normally while we prove it never reaches bootstrap/deploy. `record` only logs,
# so the generated config can be executed to reveal its effective CDK context
# without running anything.
mkdir -p "${WORK}/stub-forward" "${WORK}/stub-record"
cat > "${WORK}/stub-forward/pnpm" <<STUB
#!/usr/bin/env bash
echo "pnpm \$*" >> "\${CHORUS_STUB_LOG}"
exec "${REAL_PNPM}" "\$@"
STUB
cat > "${WORK}/stub-record/pnpm" <<'STUB'
#!/usr/bin/env bash
echo "pnpm $*" >> "${CHORUS_STUB_LOG}"
exit 0
STUB
chmod +x "${WORK}/stub-forward/pnpm" "${WORK}/stub-record/pnpm"

REPO_CONFIG="${REPO_ROOT}/default_deploy.sh"
config_fingerprint() {
  if [ -f "${REPO_CONFIG}" ]; then
    cksum < "${REPO_CONFIG}"
  else
    echo "ABSENT"
  fi
}
CONFIG_BEFORE="$(config_fingerprint)"

run_installer() { # run_installer <label> <DEPLOY_MODE> <ACM_CERT_ARN> <CUSTOM_DOMAIN>
  local label="$1" mode="$2" cert="$3" domain="$4"
  local cfg="${WORK}/deploy-${label}.sh"
  local log="${WORK}/install-${label}.log"
  local stublog="${WORK}/pnpm-install-${label}.log"
  : > "$stublog"
  ( cd "${REPO_ROOT}" && \
    PATH="${WORK}/stub-forward:${PATH}" \
    CHORUS_STUB_LOG="$stublog" \
    CHORUS_INSTALL_NONINTERACTIVE=1 \
    CHORUS_INSTALL_DRY_RUN=1 \
    CHORUS_DEPLOY_CONFIG="$cfg" \
    DEPLOY_MODE="$mode" \
    STACK_NAME="${STACK_NAME}" \
    ACM_CERT_ARN="$cert" \
    CUSTOM_DOMAIN="$domain" \
    ADMIN_EMAIL="${ADMIN_EMAIL}" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
    bash ./install.sh ) >"$log" 2>&1
  local status=$?
  ok "installer(${label}): dry run exits 0" "$status" "$( [ $status -ne 0 ] && tail -3 "$log" | tr '\n' ' ' )"
  [ $status -eq 0 ] || return 1

  ok "installer(${label}): wrote the config to the overridden path" "$( [ -f "$cfg" ] && echo 0 || echo 1 )" "$cfg"
  if grep -qE 'cdk (bootstrap|deploy)' "$stublog" 2>/dev/null; then
    ok "installer(${label}): invoked no cdk bootstrap/deploy" 1 "$(grep -E 'cdk (bootstrap|deploy)' "$stublog" | head -1)"
  else
    ok "installer(${label}): invoked no cdk bootstrap/deploy" 0
  fi

  # Persisted DEPLOY_MODE.
  if grep -qF "DEPLOY_MODE=\"${mode}\"" "$cfg"; then
    ok "installer(${label}): config persists DEPLOY_MODE=${mode}" 0
  else
    ok "installer(${label}): config persists DEPLOY_MODE=${mode}" 1 "$(grep -m1 'DEPLOY_MODE=' "$cfg")"
  fi

  # Execute the generated config against the recording stub to capture the CDK
  # context it would actually pass — stronger than grepping its source, which
  # only shows the conditional lines.
  local ctxlog="${WORK}/pnpm-config-${label}.log"
  : > "$ctxlog"
  ( PATH="${WORK}/stub-record:${PATH}" CHORUS_STUB_LOG="$ctxlog" bash "$cfg" ) \
    >"${WORK}/config-run-${label}.log" 2>&1
  ok "installer(${label}): generated config runs" $?
  local deploy_line
  deploy_line="$(grep -m1 'cdk deploy' "$ctxlog")"
  if [ -z "$deploy_line" ]; then
    ok "installer(${label}): generated config reaches the cdk deploy step" 1 "$(cat "$ctxlog")"
    return 1
  fi
  ok "installer(${label}): generated config reaches the cdk deploy step" 0

  case "$deploy_line" in
    *"-c deployMode=${mode}"*) ok "installer(${label}): emits -c deployMode=${mode}" 0 ;;
    *) ok "installer(${label}): emits -c deployMode=${mode}" 1 "$deploy_line" ;;
  esac

  if [ -n "$cert" ]; then
    case "$deploy_line" in
      *"-c acmCertificateArn=${cert}"*) ok "installer(${label}): emits -c acmCertificateArn (certificate supplied)" 0 ;;
      *) ok "installer(${label}): emits -c acmCertificateArn (certificate supplied)" 1 "$deploy_line" ;;
    esac
  else
    case "$deploy_line" in
      *"-c acmCertificateArn"*) ok "installer(${label}): omits -c acmCertificateArn (no certificate)" 1 "$deploy_line" ;;
      *) ok "installer(${label}): omits -c acmCertificateArn (no certificate)" 0 ;;
    esac
  fi

  if [ -n "$domain" ]; then
    case "$deploy_line" in
      *"-c customDomain=${domain}"*) ok "installer(${label}): emits -c customDomain" 0 ;;
      *) ok "installer(${label}): emits -c customDomain" 1 "$deploy_line" ;;
    esac
  else
    case "$deploy_line" in
      *"-c customDomain"*) ok "installer(${label}): omits -c customDomain (none given)" 1 "$deploy_line" ;;
      *) ok "installer(${label}): omits -c customDomain (none given)" 0 ;;
    esac
  fi

  echo "      context: ${deploy_line}"
}

run_installer alb alb "${ALB_CERT}" ""
run_installer cf-domain cloudfront "${CF_CERT}" "${CF_DOMAIN}"
run_installer cf-nocert cloudfront "" ""

# An invalid non-interactive configuration must fail loudly instead of prompting.
run_installer_expect_failure() { # <label> <expected substring> <mode> <cert> <domain>
  local label="$1" expected="$2" mode="$3" cert="$4" domain="$5"
  local cfg="${WORK}/deploy-${label}.sh" log="${WORK}/install-${label}.log"
  ( cd "${REPO_ROOT}" && \
    CHORUS_INSTALL_NONINTERACTIVE=1 CHORUS_INSTALL_DRY_RUN=1 \
    CHORUS_DEPLOY_CONFIG="$cfg" DEPLOY_MODE="$mode" STACK_NAME="${STACK_NAME}" \
    ACM_CERT_ARN="$cert" CUSTOM_DOMAIN="$domain" \
    ADMIN_EMAIL="${ADMIN_EMAIL}" ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
    bash ./install.sh ) >"$log" 2>&1
  local status=$?
  if [ $status -eq 0 ]; then
    ok "installer(${label}): rejected as expected" 1 "exited 0"
    return
  fi
  if grep -qF "$expected" "$log"; then
    ok "installer(${label}): rejected as expected" 0 "\"${expected}\""
  else
    ok "installer(${label}): rejected as expected" 1 "expected \"${expected}\", got: $(tail -2 "$log" | tr '\n' ' ')"
  fi
}

run_installer_expect_failure alb-no-cert "ACM_CERT_ARN is required in alb mode" alb "" ""
run_installer_expect_failure cf-cert-no-domain "was supplied without CUSTOM_DOMAIN" cloudfront "${CF_CERT}" ""
run_installer_expect_failure bad-mode "DEPLOY_MODE must be" wat "" ""

CONFIG_AFTER="$(config_fingerprint)"
if [ "$CONFIG_BEFORE" = "$CONFIG_AFTER" ]; then
  ok "the repository's default_deploy.sh was left untouched" 0
else
  ok "the repository's default_deploy.sh was left untouched" 1 "${CONFIG_BEFORE} -> ${CONFIG_AFTER}"
fi

# ──────────────────────────────────────────────
# 6. The two operational consequences are documented where a deployer sees them
# ──────────────────────────────────────────────
section "Deployment documentation"
DOC="${REPO_ROOT}/docs/DEPLOYMENT_MODES.md"
ok "docs/DEPLOYMENT_MODES.md exists" "$( [ -f "$DOC" ] && echo 0 || echo 1 )"
if [ -f "$DOC" ]; then
  grep -qiE "immutable|cannot be updated in place|replacement property" "$DOC" \
    && grep -qi "new stack" "$DOC"
  ok "doc: mode switching needs a new stack because the LB scheme cannot change in place" $?
  grep -qi "curl" "$DOC" && grep -qi "private" "$DOC"
  ok "doc: the cloudfront-mode ALB is private and not directly curl-able" $?
fi
# install.sh says the same thing at the moment the mode is chosen.
CF_INSTALL_LOG="${WORK}/install-cf-domain.log"
if [ -f "$CF_INSTALL_LOG" ]; then
  grep -qiE "immutable|cannot be updated in place" "$CF_INSTALL_LOG"
  ok "installer: cloudfront run warns the load balancer scheme cannot change in place" $?
  grep -qi "cannot curl" "$CF_INSTALL_LOG"
  ok "installer: cloudfront run warns the ALB cannot be curled" $?
fi

# ──────────────────────────────────────────────
section "Result"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED — both deployment modes verified by synth; nothing deployed."
  exit 0
fi
echo "${FAILS} CHECK(S) FAILED"
exit 1
