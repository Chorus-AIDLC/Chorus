# AWS Deployment Modes (`alb` / `cloudfront`)

The AWS CDK deployment (`./install.sh`, `packages/chorus-cdk`) offers two front
doors. Pick one with the installer's **Deployment mode** prompt, or pass
`-c deployMode=<alb|cloudfront>` to `cdk deploy` directly. Omitting it means
`alb`, which is what every deployment made before this option existed uses.

| | `alb` (default) | `cloudfront` |
|---|---|---|
| Front door | Internet-facing Application Load Balancer | CloudFront distribution |
| TLS terminates at | The ALB | The CloudFront edge |
| ALB scheme / subnets | `internet-facing`, public subnets | `internal`, private subnets |
| ALB listener | HTTPS :443 | HTTP :80, reached through a CloudFront VPC origin |
| ACM certificate | **Required**, issued in the *deployment* region | **Optional**, and when supplied must be issued in **us-east-1** |
| Custom domain | Optional | Optional, but a domain and a certificate must be supplied together |
| Public hostname without a custom domain | The ALB DNS name | The distribution's `*.cloudfront.net` domain |

`cloudfront` mode exists for deployments that have no regional certificate to
hand: CloudFront's own certificate serves the `*.cloudfront.net` domain, so the
stack can go up with no ACM certificate at all.

Neither mode creates a Route 53 record or hosted zone. When you use a custom
domain you point it at the front door yourself, using the stack outputs:
`AlbDnsName` in `alb` mode, `CloudFrontDomainName` in `cloudfront` mode.

## Two operational consequences to plan around

### 1. Switching modes on an existing deployment requires a new stack

A load balancer's scheme (`internet-facing` vs `internal`) **cannot be updated in
place**: for `AWS::ElasticLoadBalancingV2::LoadBalancer`, `Scheme` is a
replacement property. So re-deploying an existing `alb`-mode stack with
`-c deployMode=cloudfront` (or the reverse) does not convert it — CloudFormation
deletes the load balancer and creates a new one. You get a new ALB DNS name, any
CNAME pointing at the old one breaks, and the listener/target-group set is torn
down and rebuilt around it. That is a disruptive replacement, not a migration.

To move an existing deployment to the other mode, deploy a **new stack** (a
different `stackName`), verify it, migrate your data and DNS, then delete the
old stack. Choose the mode before the first deploy if you can.

Changing the mode is the only reason the front door gets replaced; everything else
about the modes (certificate, custom domain, secrets) is an ordinary update.

### 2. In `cloudfront` mode the ALB is private and cannot be curled

The `cloudfront`-mode ALB is `internal` and sits in private subnets, so its DNS
name resolves to private addresses and is unreachable from a workstation.
`curl https://<AlbDnsName>` — the usual way to bypass the CDN and check whether
the origin is healthy — is not available. Note also that the origin listener is
plain HTTP on port 80; TLS exists only between the viewer and CloudFront.

Debug through one of these instead:

- the CloudFront domain (or your custom domain) — the only public entry point;
- `aws ecs execute-command` into the running task (ECS Exec) and curl
  `localhost:8637` from inside the container;
- the ECS service's CloudWatch logs and the ALB target group health in the
  console;
- a bastion / VPN inside the VPC, if you need to reach the ALB DNS name itself.

## Verifying a change to either mode without deploying

```bash
pnpm -C packages/chorus-cdk run verify:modes
```

`packages/chorus-cdk/scripts/verify-deploy-modes.sh` synthesizes both modes,
asserts the emitted CloudFormation template facts, checks that the wrong-region
and unpaired-certificate configurations fail with clear errors, diffs the
`alb`-mode template against the pre-change commit (resource set and logical IDs
must be identical, so upgrading an existing stack replaces nothing), and drives
`install.sh` non-interactively per mode. It deploys nothing — no `cdk bootstrap`,
no `cdk deploy` — and writes its generated deployment configs to a scratch
directory rather than the repository's `default_deploy.sh`.

## Non-interactive installs

`install.sh` normally prompts. These environment variables drive it without a
TTY, and are what the verification script above uses:

| Variable | Effect |
|---|---|
| `CHORUS_INSTALL_NONINTERACTIVE=1` | Read configuration from the environment instead of prompting: `DEPLOY_MODE`, `STACK_NAME`, `ACM_CERT_ARN`, `CUSTOM_DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NEXTAUTH_SECRET`. The same validation still runs, but a violation is a hard error instead of a re-prompt. |
| `CHORUS_DEPLOY_CONFIG=<path>` | Write the generated deployment config here instead of `./default_deploy.sh`. |
| `CHORUS_INSTALL_DRY_RUN=1` | Stop after writing the config; run no `cdk bootstrap` and no `cdk deploy`. |

With none of them set, `install.sh` behaves exactly as before.

## Region availability

CloudFront VPC origins are not available in every region. `install.sh` carries a
list of regions known to support them and, for a region outside that list,
**warns and asks whether to continue** rather than refusing — the list can be
out of date, and the deploy itself is the authoritative answer.
