## Why

Deploying Chorus today requires an ACM certificate before anything can run. `install.sh` loops on the prompt until the answer starts with `arn:aws:acm:`, `bin/chorus.ts` throws when `acmCertificateArn` is absent, and `lib/service.ts` builds a single public HTTPS listener whose only certificate comes from that ARN. A user who just wants to try Chorus must first own a domain, request a certificate, and validate it — three steps that have nothing to do with the product.

CloudFront removes that prerequisite: every distribution ships with a trusted certificate on its own `*.cloudfront.net` domain, so HTTPS works with zero certificate input. This change adds CloudFront as an alternative front door while leaving the existing ALB/ACM path byte-for-byte unchanged for the deployments already running on it.

## What Changes

- Introduce a `DEPLOY_MODE` deployment mode with two values, `alb` (default) and `cloudfront`, threaded from `install.sh` through CDK context into the stack.
- Mode `alb` keeps today's behaviour exactly: internet-facing ALB, port 443 HTTPS listener, **required** regional ACM certificate, optional custom domain CNAME'd to the ALB DNS name.
- Mode `cloudfront` makes the ALB internal (`internetFacing: false`) with a plain HTTP:80 listener in the private subnets and fronts it with a CloudFront distribution using `origins.VpcOrigin.withApplicationLoadBalancer()`, so the ALB is unreachable from the internet without any prefix list or shared secret header.
- Make the ACM certificate **optional in `cloudfront` mode**: with no certificate the distribution serves its default `*.cloudfront.net` certificate and domain; with a custom domain the operator supplies a **us-east-1** certificate ARN reusing the same `ACM_CERT_ARN` / `acmCertificateArn` key.
- Validate the certificate region per mode — regional for `alb`, `us-east-1` for `cloudfront` — and fail synth with an explicit message when the region is wrong.
- Derive the public URL in the CDK (custom domain when present, otherwise the distribution domain name) and feed it to `NEXTAUTH_URL`, so a single deploy pass produces working OIDC callbacks.
- Set the CloudFront origin `readTimeout` to 60 seconds so the app's 30-second SSE heartbeat cannot trip the default 30-second origin response timeout. No application change is needed and no total-duration cap is introduced.
- Warn (not fail) in `install.sh` when the target region is not in the known CloudFront-VPC-origins region list, and ask whether to continue.
- Add a non-interactive path to `install.sh` (`CHORUS_INSTALL_NONINTERACTIVE`, plus a config-path override and a dry-run stop), since the script is `read -rp` only today and nothing can drive it without a TTY.
- Emit the distribution domain name as a stack output; DNS record creation stays the operator's responsibility (no Route 53 alias is created).

## Capabilities

### New Capabilities

- `cloudfront-deploy-mode`: a selectable CloudFront front door for the Chorus stack that makes the ACM certificate optional and keeps the ALB private.

### Modified Capabilities

None.

## Impact

- `install.sh`: new `DEPLOY_MODE` prompt, mode-aware certificate prompting and validation, region warning, `-c deployMode=` context arg, `DEPLOY_MODE` persisted into the generated `default_deploy.sh`, and an additive non-interactive / dry-run path.
- `packages/chorus-cdk/bin/chorus.ts`: read `deployMode`, replace the unconditional `acmCertificateArn` requirement with a mode-aware check, and pass the mode into `ChorusStack`.
- `packages/chorus-cdk/lib/chorus-stack.ts`: thread `deployMode` to `Service`.
- `packages/chorus-cdk/lib/service.ts`: branch listener scheme/protocol on the mode, add the CloudFront distribution and VPC origin, derive `NEXTAUTH_URL` from the front door, and add the distribution-domain output.
- No dependency change: `aws-cdk-lib ^2.233.0` already ships `aws_cloudfront_origins.VpcOrigin`.
- No application/runtime change: the SSE heartbeat in `src/app/api/events/route.ts` and `src/app/api/events/notifications/route.ts` stays at 30 seconds.
- **Migration constraint to document:** an ALB's scheme is immutable, so an existing stack deployed in `alb` mode cannot be switched to `cloudfront` mode in place — the switch requires a new stack. Debugging in `cloudfront` mode also cannot `curl` the ALB directly because it is private.
- Out of scope by explicit decision: WAF, CloudFront access logging, geo restriction, price-class tuning, Route 53 automation, and any live AWS deployment as part of verification.

## Verification

A standalone script (the CDK package has no test framework) that synths both modes and asserts their template facts, diffs the `alb`-mode template against the pre-change template for logical-ID stability, and drives `install.sh` non-interactively to assert the generated config per mode. Explicitly **no live AWS deploy** in this change.
