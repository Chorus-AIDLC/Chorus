#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { ChorusStack } from '../lib/chorus-stack';
import {
  DEFAULT_DEPLOY_MODE,
  DEPLOY_MODES,
  DeployMode,
} from '../lib/deploy-mode';

const app = new cdk.App();

const stackName = app.node.tryGetContext('stackName') || 'Chorus';
const acmCertificateArn = app.node.tryGetContext('acmCertificateArn') || '';
const customDomain = app.node.tryGetContext('customDomain') || '';
const superAdminEmail = app.node.tryGetContext('superAdminEmail') || '';
const superAdminPassword = app.node.tryGetContext('superAdminPassword') || '';
const nextAuthSecret =
  app.node.tryGetContext('nextAuthSecret') ||
  crypto.randomBytes(32).toString('hex');

// Deployment mode: absent or empty resolves to `alb`, anything unrecognised is
// a hard synth error so a typo cannot silently downgrade the front door.
const deployModeRaw = String(app.node.tryGetContext('deployMode') || '').trim();
const deployMode = (deployModeRaw || DEFAULT_DEPLOY_MODE) as DeployMode;
if (!DEPLOY_MODES.includes(deployMode)) {
  throw new Error(
    `deployMode "${deployModeRaw}" is not supported. Accepted values are: ${DEPLOY_MODES.join(
      ', ',
    )}. Pass it via -c deployMode=cloudfront`,
  );
}

/** Region field of an ACM ARN: arn:aws:acm:<region>:<account>:certificate/<id> */
const certificateRegion = (arn: string): string => arn.split(':')[3] || '';

// Validate required parameters
if (deployMode === 'alb') {
  if (!acmCertificateArn) {
    throw new Error(
      'acmCertificateArn is required. Pass it via -c acmCertificateArn=arn:aws:acm:...',
    );
  }
  // ChorusStack is region-agnostic (no `env`), so `stack.region` is a synth-time
  // token and cannot be string-compared. Use the ambient CDK/AWS region instead,
  // and skip the check entirely when neither variable is set.
  const deployRegion =
    process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || '';
  const certRegion = certificateRegion(acmCertificateArn);
  if (deployRegion && certRegion && certRegion !== deployRegion) {
    throw new Error(
      `acmCertificateArn is from region "${certRegion}" but the deployment region is "${deployRegion}". ` +
        'An ALB listener requires a certificate from its own region. Provide a certificate issued in ' +
        `"${deployRegion}", or deploy into "${certRegion}".`,
    );
  }
} else {
  // cloudfront mode: the certificate is optional (the distribution falls back to
  // its default *.cloudfront.net certificate), but when supplied it must come
  // from us-east-1 and must be paired with the custom domain it secures.
  const certRegion = certificateRegion(acmCertificateArn);
  if (acmCertificateArn && certRegion !== 'us-east-1') {
    throw new Error(
      `acmCertificateArn is from region "${certRegion}", but CloudFront alternate domain names require a ` +
        'certificate from us-east-1. Issue or import the certificate in us-east-1, or omit it to use the ' +
        'default CloudFront certificate on the *.cloudfront.net domain.',
    );
  }
  if (Boolean(acmCertificateArn) !== Boolean(customDomain)) {
    throw new Error(
      'customDomain and acmCertificateArn must be supplied together in cloudfront mode: a custom domain ' +
        'cannot be added as an alternate domain name without a certificate, and a certificate has nothing ' +
        'to secure without a domain. Supply both, or neither to use the default CloudFront domain.',
    );
  }
}
if (!superAdminEmail) {
  throw new Error(
    'superAdminEmail is required. Pass it via -c superAdminEmail=admin@example.com',
  );
}
if (!superAdminPassword) {
  throw new Error(
    'superAdminPassword is required. Pass it via -c superAdminPassword=yourpassword',
  );
}

// Hash password at synth time
const superAdminPasswordHash = bcrypt.hashSync(superAdminPassword, 10);

new ChorusStack(app, stackName, {
  deployMode,
  acmCertificateArn,
  customDomain,
  superAdminEmail,
  superAdminPasswordHash,
  nextAuthSecret,
});
