# Design: CloudFront deployment mode

## 1. Current state

Three places hard-require an ACM certificate:

| Location | Behaviour |
|---|---|
| `install.sh:62-68` | `while true` loop that only exits when the answer matches `arn:aws:acm:*` |
| `packages/chorus-cdk/bin/chorus.ts:20-24` | throws `acmCertificateArn is required` when the context value is empty |
| `packages/chorus-cdk/lib/service.ts:53-67` | `internetFacing: true` ALB with one `port: 443` / `HTTPS` listener whose `certificates: [ListenerCertificate.fromArn(props.acmCertificateArn)]` |

The listener carries three rules: priority 1 forwards requests whose `Host` is the ALB DNS name, a `CfnListenerRule` at priority 2 (conditional on `HasCustomDomain`) forwards the custom domain, and the default action returns a 403 fixed response. `NEXTAUTH_URL` is `https://` + (custom domain when set, else the ALB DNS name), computed with `Fn.conditionIf`.

## 2. Mode selection

A single new parameter, threaded end to end:

```
install.sh DEPLOY_MODE  ->  -c deployMode=<alb|cloudfront>  ->  ChorusStackProps.deployMode  ->  ServiceProps.deployMode
```

`alb` is the default everywhere — an empty or absent `deployMode` resolves to `alb`. That keeps every existing scripted install, every regenerated `default_deploy.sh`, and every non-interactive `cdk deploy` on today's behaviour with no edit. Any other value is a hard synth error, so a typo cannot silently downgrade the front door.

Because the mode changes which CloudFormation resources exist (not just their property values), the branch is a **synth-time TypeScript branch**, not a `CfnCondition`. `CfnCondition` is retained only where it already exists, for the optional custom domain within `alb` mode.

## 3. Topology per mode

### 3.1 `alb` (unchanged)

```
Internet -> ALB (public subnets, internetFacing, :443 HTTPS, regional ACM cert) -> TargetGroup :8637 -> Fargate (private)
```

All three listener rules, the 403 default, the `HasCustomDomain` condition and both existing outputs are preserved verbatim. Re-deploying an existing stack after this change must be a no-op diff.

### 3.2 `cloudfront`

```
Internet -> CloudFront distribution (default *.cloudfront.net cert, or alternate domain w/ us-east-1 cert)
              |
              +-- VpcOrigin.withApplicationLoadBalancer(alb)
                          |
                          v
            ALB (private subnets, internetFacing: false, :80 HTTP) -> TargetGroup :8637 -> Fargate (private)
```

The ALB moves into `PRIVATE_WITH_EGRESS` subnets and drops TLS entirely: CloudFront terminates TLS at the edge, and the edge-to-origin hop is a VPC origin, which AWS routes over the CloudFront-managed VPC interface rather than the public internet. That is why no extra lockdown is needed — there is no public listener to protect, so the alternatives (a `com.amazonaws.global.cloudfront.origin-facing` prefix list ingress rule, or a shared secret header) are deliberately not implemented.

Consequences that must be documented, not worked around:

- **An ALB's scheme is immutable.** CloudFormation cannot flip `internetFacing` on an existing load balancer, so an already-deployed `alb`-mode stack cannot be converted in place. Switching modes means a new stack.
- **The origin is not directly reachable.** Debugging in `cloudfront` mode cannot `curl` the ALB DNS name from a workstation; use CloudFront, ECS exec, or a bastion inside the VPC.

Host-header routing also changes shape. CloudFront's VPC origin forwards the viewer `Host` header under `OriginRequestPolicy.ALL_VIEWER`, so in `cloudfront` mode the listener forwards unconditionally to the target group rather than matching on host. The ALB-DNS / custom-domain / 403 rule trio exists to keep a *public* ALB from serving arbitrary hosts; a private ALB behind a single distribution has no such exposure.

## 4. Certificate handling

`ACM_CERT_ARN` / `acmCertificateArn` is one key with a mode-dependent contract:

| Mode | Certificate | Region required | Empty value |
|---|---|---|---|
| `alb` | required | the stack's own region | hard error (today's behaviour) |
| `cloudfront` | optional | `us-east-1` | default CloudFront certificate + `*.cloudfront.net` domain |

Reusing one key rather than adding `cloudfrontCertificateArn` keeps `install.sh`, the persisted `default_deploy.sh`, and the CDK context surface at their current size; the mode already disambiguates the meaning.

Region validation is a string check on the ARN's 4th colon-separated field, performed at synth time in `bin/chorus.ts` where the failure is loudest and cheapest:

- `cloudfront` mode + a certificate whose region is not `us-east-1` -> throw, naming the requirement (CloudFront alternate domain names accept certificates only from us-east-1).
- `alb` mode + a certificate from a different region than the deploy region -> throw, since an ALB listener can only attach a certificate from its own region.

The `alb`-mode check needs care: `ChorusStack` is constructed with no `env`, so it is region-agnostic and `stack.region` resolves to a `${AWS::Region}` token rather than a string. The check therefore reads the region from `CDK_DEFAULT_REGION` / `AWS_REGION` and **no-ops when neither is set**, rather than comparing against a token or inventing a default. The `cloudfront`-mode check needs no ambient region — it is an absolute comparison against the literal `us-east-1`.

A certificate implies a custom domain in `cloudfront` mode, and a custom domain implies a certificate. Supplying exactly one of the pair is an error rather than a silent partial configuration: a domain with no certificate cannot be added as an alternate domain name, and a certificate with no domain has nothing to secure.

## 5. Distribution configuration

One default behaviour, no additional path patterns. Chorus is a fully dynamic Next.js application behind auth, so caching is off:

- `cachePolicy: CachePolicy.CACHING_DISABLED`
- `allowedMethods: ALLOW_ALL` (the app uses GET/POST/PUT/PATCH/DELETE across REST, MCP and server actions)
- `originRequestPolicy: OriginRequestPolicy.ALL_VIEWER` — forwards all viewer headers, cookies and query strings, which is what session cookies, `Authorization: Bearer cho_…` API keys and the `Host`-derived callback all require
- `viewerProtocolPolicy: REDIRECT_TO_HTTPS`

Deliberately omitted: WAF association, access logging, geo restriction, and price class tuning. Each is a separate operational decision with its own cost, and none is required for the front door to work.

## 6. SSE and timeouts

Chorus has exactly two `text/event-stream` routes — `src/app/api/events/route.ts` and `src/app/api/events/notifications/route.ts` — and both emit `": heartbeat\n\n"` every 30 seconds.

Two CloudFront timeouts matter, and they behave differently:

- **`readTimeout`** (origin response timeout, default **30 s**, max 60 s without an approved quota increase) bounds the gap between successive bytes from the origin. A 30-second heartbeat against a 30-second read timeout is a race with no margin.
- **`responseCompletionTimeout`** would cap the *total* duration of a response, which is exactly what would kill a long-lived SSE stream. Its default is *not enforced*. It is also not settable here at all: `VpcOriginProps` in the installed `aws-cdk-lib` (`node_modules/aws-cdk-lib/aws-cloudfront-origins/lib/vpc-origin.d.ts`) exposes only `readTimeout` and `keepaliveTimeout`, so a VPC origin cannot emit a response-completion timeout even by accident.

Therefore: set `readTimeout: Duration.seconds(60)` on the VPC origin. `keepaliveTimeout` stays at its 5-second default. This is a CDK-only fix — the application heartbeat interval is not touched, so there is no runtime behaviour to regress.

**Origin reachability.** The ALB security group must admit the CloudFront VPC origin on port 80. CDK's `addListener` defaults to `open: true`, which opens the listener port on the ALB security group; since the ALB is internal, that exposure is confined to the VPC plus the CloudFront-managed VPC origin path. This must be asserted rather than assumed, because a listener created with `open: false` would synth cleanly and then fail every request at runtime.

## 7. Public URL derivation

In `cloudfront` mode the public URL is resolved in the CDK so a single deploy pass yields a working `NEXTAUTH_URL` and OIDC callback:

```
publicUrl = 'https://' + (customDomain !== '' ? customDomain : distribution.domainName)
```

`distribution.domainName` is a CloudFormation attribute reference, available during the same deploy that creates the distribution, which is why no second pass is needed. The existing `Fn.conditionIf(HasCustomDomain, …)` derivation stays in place for `alb` mode.

Outputs: `portalURL` continues to carry the public URL in both modes. `alb` mode keeps `AlbDnsName` (the CNAME target). `cloudfront` mode adds the distribution domain name so the operator can create their own DNS record — no Route 53 alias is created, because the hosted zone may not live in this account.

## 8. Region availability

CloudFront VPC origins are not available in every region. `install.sh` carries a known-supported region list and, when the target region is absent from it, **warns and asks whether to continue** rather than failing. A stale hardcoded list must not block a user in a region where the feature has since launched; the authoritative answer comes from the deploy itself.

## 9. Non-interactive installer path

`install.sh` today is `read -rp` only, so nothing can drive it without a TTY. This change adds an explicit non-interactive path, which the idea asks for and which the verification below depends on:

- `CHORUS_INSTALL_NONINTERACTIVE=1` makes `collect_config` take each value from an environment variable instead of prompting: `DEPLOY_MODE`, `STACK_NAME`, `ACM_CERT_ARN`, `CUSTOM_DOMAIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `NEXTAUTH_SECRET`. The same per-mode validation still runs, but a violation is a hard error instead of a re-prompt (there is no one to re-prompt), and the region warning auto-continues.
- `CHORUS_DEPLOY_CONFIG` overrides the generated config path, which today is the hardcoded `${SCRIPT_DIR}/default_deploy.sh`. Without this a dry run would overwrite the operator's live deploy script.
- `CHORUS_INSTALL_DRY_RUN=1` stops after `save_deploy_config`, so no `cdk bootstrap` or `cdk deploy` is invoked.

These are additive: with none of them set, the script behaves exactly as it does today.

## 10. Verification strategy

No live AWS deployment. A standalone script — `packages/chorus-cdk` has no `test` script and no test framework in its devDependencies, so this is a shell script driving the CDK CLI, not a new test harness:

1. **`cdk synth` for both modes**, asserting on the produced template:
   - `alb` mode: listener `Protocol: HTTPS`, `Port: 443`, certificate attached, `Scheme: internet-facing`, no `AWS::CloudFront::Distribution`.
   - `cloudfront` mode: listener `Protocol: HTTP`, `Port: 80`, `Scheme: internal`, ALB security-group ingress on port 80, one `AWS::CloudFront::Distribution` with a VPC origin, `OriginReadTimeout: 60`, caching disabled, and `NEXTAUTH_URL` sourced from the distribution domain.
   - wrong-region certificate in each mode raises the expected error.
2. **Backwards-compatibility diff.** Synth `alb` mode from the pre-change commit and from the working tree with identical context, then compare the two templates' resource sets and logical IDs. They must be identical. Asserting listener properties alone is insufficient: introducing a nested construct scope for the mode branch would keep every property assertion green while renaming logical IDs, which CloudFormation executes as a *replacement* of the load balancer on an upgraded stack — the exact outcome "existing alb-mode stacks unchanged" forbids.
3. **`install.sh` non-interactive dry run** using §9's variables, asserting per mode that the generated config persists `DEPLOY_MODE`, emits the matching `-c deployMode=` argument, and includes `-c acmCertificateArn=` only when a certificate was supplied — written to the overridden path, with no `cdk bootstrap`/`deploy` invoked.
