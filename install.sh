#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="${SCRIPT_DIR}/packages/chorus-cdk"

# Generated deployment config. CHORUS_DEPLOY_CONFIG lets a dry run write
# somewhere else instead of clobbering the operator's live deploy script.
DEPLOY_CONFIG="${CHORUS_DEPLOY_CONFIG:-${SCRIPT_DIR}/default_deploy.sh}"

# Non-interactive switches (all additive — unset means "behave as before").
NONINTERACTIVE="${CHORUS_INSTALL_NONINTERACTIVE:-}"
DRY_RUN="${CHORUS_INSTALL_DRY_RUN:-}"

# Regions known to support CloudFront VPC origins. Intentionally advisory only:
# a stale list must never block a deploy in a region where the feature has since
# launched, so a miss warns and asks rather than failing.
CLOUDFRONT_VPC_ORIGIN_REGIONS="us-east-1 us-east-2 us-west-1 us-west-2 ca-central-1 ap-northeast-1 ap-northeast-2 ap-south-1 ap-southeast-1 ap-southeast-2 eu-central-1 eu-west-1 eu-west-2 sa-east-1"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }

# ──────────────────────────────────────────────
# Small helpers (bash 3.2 safe — no associative arrays, no ${VAR,,})
# ──────────────────────────────────────────────

# Region the stack will deploy into, using the same precedence as the AWS CLI.
# Prints nothing when the region cannot be resolved — inventing a default here
# would silently suppress the CloudFront VPC-origin region warning below.
resolve_region() {
  local region="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [ -z "$region" ]; then
    region="$(aws configure get region 2>/dev/null || true)"
  fi
  echo "$region"
}

is_acm_arn() {
  case "$1" in
    arn:aws:acm:*) return 0 ;;
    *) return 1 ;;
  esac
}

# Region field of arn:aws:acm:<region>:<account>:certificate/<id>
acm_arn_region() {
  echo "$1" | cut -d: -f4
}

region_supports_vpc_origins() {
  local candidate="$1" known
  for known in $CLOUDFRONT_VPC_ORIGIN_REGIONS; do
    if [ "$known" = "$candidate" ]; then
      return 0
    fi
  done
  return 1
}

# Warn (never fail) when CloudFront VPC origins may not exist in this region.
check_cloudfront_region() {
  local region="${AWS_TARGET_REGION:-}"
  if region_supports_vpc_origins "$region"; then
    return 0
  fi
  if [ -z "$region" ]; then
    warn "Could not resolve a deploy region (AWS_REGION / AWS_DEFAULT_REGION / 'aws configure get region' are all unset),"
    warn "so this installer cannot tell whether CloudFront VPC origins are available where you are deploying."
  else
    warn "Region '${region}' is not in this installer's list of regions known to support CloudFront VPC origins."
  fi
  warn "That list can be out of date — if VPC origins have since launched there, the deployment will just work."
  if [ -n "$NONINTERACTIVE" ]; then
    info "Non-interactive mode: continuing anyway."
    return 0
  fi
  local cont
  read -rp "Continue anyway? [y/N]: " cont
  if [[ ! "${cont:-N}" =~ ^[Yy]$ ]]; then
    error "Aborted before deployment. Re-run with a supported region, or continue at the prompt."
    exit 1
  fi
}

# The two consequences of cloudfront mode a deployer has to plan around. Shown
# on every cloudfront install, interactive or not — see docs/DEPLOYMENT_MODES.md.
cloudfront_mode_notice() {
  warn "CloudFront mode — two things to know before you deploy:"
  warn "  1. A load balancer's scheme cannot be updated in place — CloudFormation would REPLACE the"
  warn "     ALB (new DNS name, broken CNAME). Switching modes means deploying a NEW stack"
  warn "     (different stack name), migrating data and DNS, then deleting the old one."
  warn "  2. The ALB will be internal (private subnets, HTTP on port 80), so you cannot curl its"
  warn "     DNS name from your workstation to debug the origin. Use the CloudFront domain, ECS"
  warn "     Exec into the task, CloudWatch logs, or a bastion inside the VPC."
  info "Details: docs/DEPLOYMENT_MODES.md"
}

# ──────────────────────────────────────────────
# Check prerequisites
# ──────────────────────────────────────────────
check_prerequisites() {
  local missing=0
  for cmd in aws node pnpm; do
    if ! command -v "$cmd" &>/dev/null; then
      error "$cmd is not installed"
      missing=1
    fi
  done
  if [ "$missing" -eq 1 ]; then
    exit 1
  fi

  # Check AWS credentials
  if ! aws sts get-caller-identity &>/dev/null; then
    error "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE."
    exit 1
  fi

  local account_id
  account_id=$(aws sts get-caller-identity --query Account --output text)
  AWS_TARGET_REGION="$(resolve_region)"
  info "AWS Account: ${account_id}, Region: ${AWS_TARGET_REGION:-<unresolved>}"
}

# ──────────────────────────────────────────────
# Collect configuration interactively
# ──────────────────────────────────────────────
collect_config() {
  if [ -n "$NONINTERACTIVE" ]; then
    collect_config_from_env
    return
  fi

  echo ""
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo -e "${CYAN}  Chorus CDK Deployment Configuration${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════${NC}"
  echo ""

  # Deployment mode: alb (internet-facing ALB) or cloudfront (CloudFront + internal ALB)
  while true; do
    read -rp "Deployment mode [alb] (alb|cloudfront): " DEPLOY_MODE
    DEPLOY_MODE="${DEPLOY_MODE:-alb}"
    if [ "$DEPLOY_MODE" = "alb" ] || [ "$DEPLOY_MODE" = "cloudfront" ]; then
      break
    fi
    warn "Deployment mode must be 'alb' or 'cloudfront'."
  done

  if [ "$DEPLOY_MODE" = "cloudfront" ]; then
    check_cloudfront_region
    cloudfront_mode_notice
  fi

  # Stack name
  read -rp "Stack name [Chorus]: " STACK_NAME
  STACK_NAME="${STACK_NAME:-Chorus}"

  if [ "$DEPLOY_MODE" = "alb" ]; then
    # ACM Certificate ARN (required — the HTTPS listener cannot exist without one)
    while true; do
      read -rp "ACM Certificate ARN (required): " ACM_CERT_ARN
      if [[ "$ACM_CERT_ARN" == arn:aws:acm:* ]]; then
        break
      fi
      warn "Must be a valid ACM certificate ARN (arn:aws:acm:...)"
    done

    # Custom domain (optional)
    read -rp "Custom domain (optional, e.g. chorus.example.com): " CUSTOM_DOMAIN
  else
    # cloudfront: the certificate only exists to secure a custom domain, so ask
    # for the domain first and skip the certificate entirely when there is none.
    read -rp "Custom domain (optional, e.g. chorus.example.com): " CUSTOM_DOMAIN
    if [ -n "$CUSTOM_DOMAIN" ]; then
      while true; do
        read -rp "ACM Certificate ARN (required, must be issued in us-east-1): " ACM_CERT_ARN
        if ! is_acm_arn "$ACM_CERT_ARN"; then
          warn "Must be a valid ACM certificate ARN (arn:aws:acm:...)"
          continue
        fi
        local cert_region
        cert_region="$(acm_arn_region "$ACM_CERT_ARN")"
        if [ "$cert_region" != "us-east-1" ]; then
          warn "Certificate is in region '${cert_region}'. CloudFront alternate domain names require a us-east-1 certificate."
          continue
        fi
        break
      done
    else
      ACM_CERT_ARN=""
      info "No custom domain given — the deployment will use CloudFront's own certificate on its *.cloudfront.net domain."
    fi
  fi

  # Super admin email (required)
  while true; do
    read -rp "Super admin email (required): " ADMIN_EMAIL
    if [[ "$ADMIN_EMAIL" == *@* ]]; then
      break
    fi
    warn "Please enter a valid email address."
  done

  # Super admin password (required)
  while true; do
    read -rsp "Super admin password (required, min 8 chars): " ADMIN_PASSWORD
    echo ""
    if [ "${#ADMIN_PASSWORD}" -ge 8 ]; then
      break
    fi
    warn "Password must be at least 8 characters."
  done

  # NextAuth secret (optional)
  read -rp "NextAuth secret (leave empty to auto-generate): " NEXTAUTH_SECRET
}

# ──────────────────────────────────────────────
# Collect configuration from the environment (CHORUS_INSTALL_NONINTERACTIVE=1)
# Same validation rules as the interactive path, but a violation is fatal —
# there is nobody to re-prompt.
# ──────────────────────────────────────────────
collect_config_from_env() {
  info "Non-interactive mode: reading configuration from the environment."

  DEPLOY_MODE="${DEPLOY_MODE:-alb}"
  if [ "$DEPLOY_MODE" != "alb" ] && [ "$DEPLOY_MODE" != "cloudfront" ]; then
    error "DEPLOY_MODE must be 'alb' or 'cloudfront' (got '${DEPLOY_MODE}')."
    exit 1
  fi

  STACK_NAME="${STACK_NAME:-Chorus}"
  ACM_CERT_ARN="${ACM_CERT_ARN:-}"
  CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
  ADMIN_EMAIL="${ADMIN_EMAIL:-}"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-}"

  if [ "$DEPLOY_MODE" = "cloudfront" ]; then
    check_cloudfront_region
    cloudfront_mode_notice
  fi

  if [ "$DEPLOY_MODE" = "alb" ]; then
    if ! is_acm_arn "$ACM_CERT_ARN"; then
      error "ACM_CERT_ARN is required in alb mode and must be an ACM certificate ARN (arn:aws:acm:...)."
      exit 1
    fi
  else
    if [ -n "$CUSTOM_DOMAIN" ]; then
      if ! is_acm_arn "$ACM_CERT_ARN"; then
        error "ACM_CERT_ARN is required when CUSTOM_DOMAIN is set and must be an ACM certificate ARN (arn:aws:acm:...)."
        exit 1
      fi
      local cert_region
      cert_region="$(acm_arn_region "$ACM_CERT_ARN")"
      if [ "$cert_region" != "us-east-1" ]; then
        error "ACM_CERT_ARN is in region '${cert_region}'. CloudFront alternate domain names require a us-east-1 certificate."
        exit 1
      fi
    elif [ -n "$ACM_CERT_ARN" ]; then
      error "ACM_CERT_ARN was supplied without CUSTOM_DOMAIN. In cloudfront mode a certificate has nothing to secure without a domain — supply both, or neither."
      exit 1
    else
      info "No custom domain given — the deployment will use CloudFront's own certificate on its *.cloudfront.net domain."
    fi
  fi

  if [[ "$ADMIN_EMAIL" != *@* ]]; then
    error "ADMIN_EMAIL is required and must be a valid email address."
    exit 1
  fi
  if [ "${#ADMIN_PASSWORD}" -lt 8 ]; then
    error "ADMIN_PASSWORD is required and must be at least 8 characters."
    exit 1
  fi
}

# ──────────────────────────────────────────────
# Build CDK context arguments
# ──────────────────────────────────────────────
build_context_args() {
  CDK_CONTEXT="-c stackName=${STACK_NAME}"
  CDK_CONTEXT+=" -c deployMode=${DEPLOY_MODE}"
  CDK_CONTEXT+=" -c superAdminEmail=${ADMIN_EMAIL}"
  CDK_CONTEXT+=" -c superAdminPassword=${ADMIN_PASSWORD}"

  # Omitted entirely when absent: an empty acmCertificateArn would trip the
  # cloudfront-mode domain/certificate pairing check in bin/chorus.ts.
  if [ -n "${ACM_CERT_ARN:-}" ]; then
    CDK_CONTEXT+=" -c acmCertificateArn=${ACM_CERT_ARN}"
  fi
  if [ -n "${CUSTOM_DOMAIN:-}" ]; then
    CDK_CONTEXT+=" -c customDomain=${CUSTOM_DOMAIN}"
  fi
  if [ -n "${NEXTAUTH_SECRET:-}" ]; then
    CDK_CONTEXT+=" -c nextAuthSecret=${NEXTAUTH_SECRET}"
  fi
}

# ──────────────────────────────────────────────
# Save deployment config for re-runs
# ──────────────────────────────────────────────
save_deploy_config() {
  cat > "$DEPLOY_CONFIG" <<DEPLOY_EOF
#!/usr/bin/env bash
# Auto-generated by install.sh — DO NOT commit this file
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="\${SCRIPT_DIR}/packages/chorus-cdk"

STACK_NAME="${STACK_NAME}"
DEPLOY_MODE="${DEPLOY_MODE}"
ACM_CERT_ARN="${ACM_CERT_ARN:-}"
CUSTOM_DOMAIN="${CUSTOM_DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL}"
ADMIN_PASSWORD="${ADMIN_PASSWORD}"
NEXTAUTH_SECRET="${NEXTAUTH_SECRET:-}"

CDK_CONTEXT="-c stackName=\${STACK_NAME}"
CDK_CONTEXT+=" -c deployMode=\${DEPLOY_MODE}"
CDK_CONTEXT+=" -c superAdminEmail=\${ADMIN_EMAIL}"
CDK_CONTEXT+=" -c superAdminPassword=\${ADMIN_PASSWORD}"
[ -n "\${ACM_CERT_ARN}" ] && CDK_CONTEXT+=" -c acmCertificateArn=\${ACM_CERT_ARN}"
[ -n "\${CUSTOM_DOMAIN}" ] && CDK_CONTEXT+=" -c customDomain=\${CUSTOM_DOMAIN}"
[ -n "\${NEXTAUTH_SECRET}" ] && CDK_CONTEXT+=" -c nextAuthSecret=\${NEXTAUTH_SECRET}"

cd "\${SCRIPT_DIR}"
pnpm -C packages/chorus-cdk install
pnpm -C packages/chorus-cdk run build
pnpm -C packages/chorus-cdk exec cdk bootstrap \${CDK_CONTEXT}
pnpm -C packages/chorus-cdk exec cdk deploy \${CDK_CONTEXT} --require-approval never
DEPLOY_EOF
  chmod +x "$DEPLOY_CONFIG"
  ok "Saved deployment config to ${DEPLOY_CONFIG} (re-run with ${DEPLOY_CONFIG})"
}

# ──────────────────────────────────────────────
# Deploy
# ──────────────────────────────────────────────
deploy() {
  info "Installing dependencies..."
  pnpm -C packages/chorus-cdk install

  info "Building CDK..."
  pnpm -C packages/chorus-cdk run build

  info "Bootstrapping CDK..."
  pnpm -C packages/chorus-cdk exec cdk bootstrap ${CDK_CONTEXT}

  info "Deploying stack '${STACK_NAME}'..."
  pnpm -C packages/chorus-cdk exec cdk deploy ${CDK_CONTEXT} --require-approval never

  ok "Deployment complete!"
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
  cd "$SCRIPT_DIR"

  echo -e "${GREEN}"
  echo "  ╔═══════════════════════════════════╗"
  echo "  ║       Chorus CDK Installer        ║"
  echo "  ╚═══════════════════════════════════╝"
  echo -e "${NC}"

  # Reuse existing config? (never in non-interactive mode — nobody can answer)
  if [ -z "$NONINTERACTIVE" ] && [ -f "$DEPLOY_CONFIG" ]; then
    warn "Found existing deployment config: ${DEPLOY_CONFIG}"
    read -rp "Reuse previous configuration? [Y/n]: " reuse
    if [[ "${reuse:-Y}" =~ ^[Yy]$ ]]; then
      info "Re-running previous deployment..."
      exec "$DEPLOY_CONFIG"
    fi
  fi

  check_prerequisites
  collect_config
  build_context_args
  save_deploy_config

  if [ -n "$DRY_RUN" ]; then
    ok "Dry run: configuration written, skipping cdk bootstrap and cdk deploy."
    return 0
  fi

  deploy
}

main "$@"
