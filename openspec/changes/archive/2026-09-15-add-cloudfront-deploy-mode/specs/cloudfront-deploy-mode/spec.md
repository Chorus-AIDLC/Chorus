## ADDED Requirements

### Requirement: Deployment mode selection defaults to the existing ALB front door

The deployment tooling SHALL accept a deployment mode of either `alb` or `cloudfront`, SHALL treat an absent or empty mode as `alb`, and SHALL reject any other value with an explicit error. The mode SHALL be threaded from `install.sh` through CDK context into the stack and persisted into the generated `default_deploy.sh`.

#### Scenario: No mode supplied

- **WHEN** `cdk synth` or `cdk deploy` runs without a `deployMode` context value
- **THEN** the stack MUST synthesize the `alb` topology
- **AND** the produced template MUST NOT contain any CloudFront resource

#### Scenario: Unknown mode supplied

- **WHEN** a `deployMode` context value other than `alb` or `cloudfront` is supplied
- **THEN** synthesis MUST fail with an error naming the accepted values

#### Scenario: Mode persisted for re-runs

- **WHEN** `install.sh` completes configuration collection in either mode
- **THEN** the generated `default_deploy.sh` MUST record the selected `DEPLOY_MODE`
- **AND** it MUST emit the matching `-c deployMode=` argument in its rebuilt CDK context

### Requirement: ALB mode preserves the existing public HTTPS topology

In `alb` mode the stack SHALL keep today's behaviour unchanged: an internet-facing load balancer in the public subnets with a single port 443 HTTPS listener, a required ACM certificate from the stack's own region, and an optional custom domain routed by host header. Re-deploying an existing `alb`-mode stack after this change SHALL produce no resource replacement.

#### Scenario: ALB mode without a certificate

- **WHEN** the mode is `alb` and no certificate ARN is supplied
- **THEN** synthesis MUST fail with the existing required-certificate error

#### Scenario: ALB mode listener shape

- **WHEN** the mode is `alb` and a same-region certificate ARN is supplied
- **THEN** the template MUST contain a load balancer with scheme `internet-facing`
- **AND** its listener MUST use protocol `HTTPS` on port `443` with that certificate attached
- **AND** the host-header routing rules and the default 403 fixed response MUST be retained

#### Scenario: ALB mode template is byte-stable across the change

- **WHEN** the stack is synthesized in `alb` mode with the same context before and after this change
- **THEN** the two templates MUST declare the same set of resources with the same logical IDs
- **AND** no resource MUST be renamed into a new construct scope, since a renamed load balancer logical ID is executed by CloudFormation as a replacement

#### Scenario: ALB mode certificate from another region

- **WHEN** the mode is `alb` and the certificate ARN's region differs from the deploy region resolved from the ambient environment
- **THEN** synthesis MUST fail with an error stating that an ALB listener requires a certificate from its own region

#### Scenario: ALB mode with no ambient region

- **WHEN** the mode is `alb` and no deploy region can be resolved from the ambient environment
- **THEN** the region comparison MUST be skipped and synthesis MUST succeed
- **AND** the check MUST NOT compare against the stack's region token, which is unresolved at synth time because the stack is region-agnostic

### Requirement: CloudFront mode places the load balancer behind a VPC origin

In `cloudfront` mode the stack SHALL make the load balancer internal, place it in the private subnets, expose only a plain HTTP listener on port 80, and front it with a CloudFront distribution whose origin is that load balancer reached through a CloudFront VPC origin. The load balancer SHALL NOT be reachable from the internet, and no prefix-list ingress rule or shared secret header SHALL be required to achieve that.

#### Scenario: CloudFront mode topology

- **WHEN** the mode is `cloudfront`
- **THEN** the template MUST contain a load balancer with scheme `internal`
- **AND** its listener MUST use protocol `HTTP` on port `80` forwarding to the service target group
- **AND** the template MUST contain exactly one CloudFront distribution whose origin is a VPC origin for that load balancer

#### Scenario: CloudFront mode origin is reachable

- **WHEN** the mode is `cloudfront`
- **THEN** the load balancer's security group MUST admit inbound traffic on port 80
- **AND** the listener MUST NOT be created with security-group management disabled, which would synth cleanly and fail every request at runtime

#### Scenario: CloudFront mode behaviour configuration

- **WHEN** the mode is `cloudfront`
- **THEN** the distribution MUST define a single default behaviour with caching disabled
- **AND** that behaviour MUST allow all HTTP methods and forward all viewer headers, cookies and query strings
- **AND** it MUST redirect HTTP viewer requests to HTTPS

### Requirement: The ACM certificate is optional in CloudFront mode

In `cloudfront` mode the certificate ARN SHALL be optional: when it is absent the distribution SHALL serve its default CloudFront certificate on its own `*.cloudfront.net` domain, and when it is present the distribution SHALL add the supplied custom domain as an alternate domain name using that certificate. A supplied certificate SHALL be required to come from `us-east-1`, and the custom domain and certificate SHALL be supplied together or not at all.

#### Scenario: CloudFront mode with no certificate

- **WHEN** the mode is `cloudfront` and neither a certificate ARN nor a custom domain is supplied
- **THEN** synthesis MUST succeed
- **AND** the distribution MUST NOT declare any alternate domain name or viewer certificate ARN

#### Scenario: CloudFront mode with a us-east-1 certificate and custom domain

- **WHEN** the mode is `cloudfront` with a custom domain and a `us-east-1` certificate ARN
- **THEN** the distribution MUST list that domain as an alternate domain name
- **AND** it MUST reference that certificate as its viewer certificate

#### Scenario: CloudFront mode certificate from the wrong region

- **WHEN** the mode is `cloudfront` and the certificate ARN's region is not `us-east-1`
- **THEN** synthesis MUST fail with an error stating that CloudFront alternate domain names require a certificate from `us-east-1`

#### Scenario: Custom domain and certificate supplied apart

- **WHEN** the mode is `cloudfront` and exactly one of custom domain or certificate ARN is supplied
- **THEN** synthesis MUST fail with an error stating that the two must be supplied together

### Requirement: Long-lived SSE streams survive the CloudFront origin timeouts

The CloudFront origin SHALL use an origin response timeout of 60 seconds so that the application's 30-second server-sent-event heartbeat cannot exhaust it, and SHALL NOT set a response completion timeout, so that no total-duration cap is imposed on a stream. The application's heartbeat interval SHALL remain unchanged.

#### Scenario: Origin read timeout

- **WHEN** the mode is `cloudfront`
- **THEN** the VPC origin MUST declare an origin read timeout of 60 seconds
- **AND** the template MUST NOT declare a response completion timeout

#### Scenario: Heartbeat untouched

- **WHEN** this change is complete
- **THEN** the 30-second heartbeat interval in the event stream routes MUST be unmodified

### Requirement: The public URL is derived from the active front door

The stack SHALL derive the public URL from the front door of the selected mode — the custom domain when one is configured, otherwise the CloudFront distribution domain in `cloudfront` mode and the load balancer DNS name in `alb` mode — and SHALL pass it to the application as `NEXTAUTH_URL` within a single deploy pass. The stack SHALL output the front-door domain and SHALL NOT create any DNS record on the operator's behalf.

#### Scenario: CloudFront mode without a custom domain

- **WHEN** the mode is `cloudfront` and no custom domain is configured
- **THEN** the container's `NEXTAUTH_URL` MUST be `https://` joined with the distribution's domain name
- **AND** the stack MUST output that distribution domain name

#### Scenario: CloudFront mode with a custom domain

- **WHEN** the mode is `cloudfront` and a custom domain is configured
- **THEN** the container's `NEXTAUTH_URL` MUST be `https://` joined with that custom domain

#### Scenario: No DNS automation

- **WHEN** either mode synthesizes
- **THEN** the template MUST NOT contain a Route 53 record or hosted zone resource

### Requirement: Installer guidance covers region availability and the immutable scheme

The installer SHALL warn, without failing, when the target region is not in its known list of regions supporting CloudFront VPC origins, and SHALL ask the operator whether to continue. The documentation for this change SHALL state that a load balancer's scheme is immutable, so an existing `alb`-mode stack cannot be switched to `cloudfront` mode in place.

#### Scenario: Region not in the known list

- **WHEN** `install.sh` runs in `cloudfront` mode against a region absent from its known-supported list
- **THEN** it MUST print a warning naming the region
- **AND** it MUST ask whether to continue rather than exiting

#### Scenario: Region in the known list

- **WHEN** `install.sh` runs in `cloudfront` mode against a region present in its known-supported list
- **THEN** it MUST NOT print the region warning

#### Scenario: Mode switch limitation documented

- **WHEN** the change is delivered
- **THEN** its documentation MUST state that switching an existing deployment between modes requires a new stack because the load balancer scheme cannot be changed in place

### Requirement: The installer can be driven without a terminal

The installer SHALL support a non-interactive path in which every value it would prompt for is instead read from a named environment variable, the generated deployment-config path is overridable, and a dry-run switch stops the run after the config is written without invoking `cdk bootstrap` or `cdk deploy`. All three switches SHALL be additive: with none of them set the installer SHALL behave exactly as it does today.

#### Scenario: Non-interactive run

- **WHEN** the installer runs with the non-interactive switch set and every required value supplied by environment variable
- **THEN** it MUST NOT read from standard input
- **AND** it MUST apply the same per-mode validation, treating a violation as a hard error rather than a re-prompt

#### Scenario: Config path override protects the live script

- **WHEN** the installer runs with the deployment-config path overridden
- **THEN** it MUST write the generated config to that path
- **AND** it MUST leave the repository's `default_deploy.sh` untouched

#### Scenario: Dry run performs no deployment

- **WHEN** the installer runs with the dry-run switch set
- **THEN** it MUST stop after writing the deployment config
- **AND** it MUST NOT invoke `cdk bootstrap` or `cdk deploy`

#### Scenario: Interactive behaviour unchanged

- **WHEN** the installer runs with none of the non-interactive switches set
- **THEN** it MUST prompt interactively and write to `default_deploy.sh` as it does today
