# Tasks

## 1. Thread the deployment mode through the CDK entrypoint

- [x] Read `deployMode` from CDK context in `packages/chorus-cdk/bin/chorus.ts`, defaulting to `alb`, rejecting unknown values.
- [x] Replace the unconditional `acmCertificateArn` requirement with the mode-aware contract (required in `alb`, optional in `cloudfront`).
- [x] Add the certificate region checks: same-region for `alb`, `us-east-1` for `cloudfront`, and the domain/certificate pairing check.
- [x] Thread `deployMode` through `ChorusStackProps` into `ServiceProps`.

## 2. Add the CloudFront front door in the service construct

- [x] Branch the load balancer scheme, subnet placement and listener protocol/port on the mode in `packages/chorus-cdk/lib/service.ts`, keeping every `alb`-mode construct at its current scope and logical ID.
- [x] Build the CloudFront distribution with `VpcOrigin.withApplicationLoadBalancer()`, `readTimeout` 60s, caching disabled, all methods, all-viewer origin request policy.
- [x] Ensure the internal ALB's security group admits port 80 from the VPC origin.
- [x] Derive the public URL / `NEXTAUTH_URL` per mode and add the distribution-domain output.

## 3. Add the mode and a non-interactive path to the installer

- [x] Add the `DEPLOY_MODE` prompt and mode-aware certificate prompting/validation in `install.sh`.
- [x] Add the known-VPC-origins-region warn-and-continue check.
- [x] Add the non-interactive / config-path-override / dry-run switches.
- [x] Emit `-c deployMode=` and persist `DEPLOY_MODE` in the generated deployment config.

## 4. Verify both modes without deploying

- [x] Add a standalone verification script driving `cdk synth` and asserting both modes' template facts and the wrong-region certificate errors.
- [x] Diff the `alb`-mode template against the pre-change template for resource-set and logical-ID equality.
- [x] Drive `install.sh` non-interactively per mode and assert the generated deployment config.
- [x] Document the immutable-scheme migration constraint and the private-origin debugging consequence.
