/**
 * Front-door deployment mode.
 *
 * - `alb`: internet-facing ALB terminating TLS with a regional ACM certificate
 *   (the historical, default topology).
 * - `cloudfront`: CloudFront distribution in front of an internal ALB reached
 *   through a CloudFront VPC origin.
 */
export const DEPLOY_MODES = ['alb', 'cloudfront'] as const;

export type DeployMode = (typeof DEPLOY_MODES)[number];

/** `alb` when the mode is absent or empty, so existing installs are unchanged. */
export const DEFAULT_DEPLOY_MODE: DeployMode = 'alb';
