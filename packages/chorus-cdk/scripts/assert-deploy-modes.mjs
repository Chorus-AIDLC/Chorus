/**
 * Template assertions for the two deployment modes.
 *
 * Driven by scripts/verify-deploy-modes.sh — it synthesizes the templates and
 * passes the directory holding them as argv[2]. Expected files:
 *
 *   alb.json         alb mode, regional certificate, no custom domain
 *   cf-domain.json   cloudfront mode, custom domain + us-east-1 certificate
 *   cf-nocert.json   cloudfront mode, no domain and no certificate
 *   baseline.json    alb mode synthesized from the pre-change commit
 *
 * Exits non-zero on the first failing run (after printing every result), so the
 * shell driver can fail the whole verification.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node assert-deploy-modes.mjs <template-dir>');
  process.exit(2);
}

const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

const alb = load('alb.json');
const base = load('baseline.json');
const cf = load('cf-domain.json');
const cfNo = load('cf-nocert.json');

// Context the driver synthesizes with; kept in sync deliberately.
const ALB_CERT_REGION = process.env.VERIFY_ALB_CERT_REGION || 'us-east-1';
const CF_CERT_ARN =
  process.env.VERIFY_CF_CERT_ARN ||
  'arn:aws:acm:us-east-1:111122223333:certificate/bbbb';
const CF_DOMAIN = process.env.VERIFY_CF_DOMAIN || 'chorus.example.com';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + extra : ''}`,
  );
};
const byType = (t, tpl) =>
  Object.entries(tpl.Resources).filter(([, r]) => r.Type === t);
const one = (t, tpl) => {
  const m = byType(t, tpl);
  if (m.length !== 1) throw new Error(`expected 1 ${t}, got ${m.length}`);
  return m[0][1];
};

console.log('--- alb mode: internet-facing, HTTPS:443 + cert, host rules, no CloudFront ---');
const albLb = one('AWS::ElasticLoadBalancingV2::LoadBalancer', alb);
ok(
  'alb: Scheme=internet-facing',
  albLb.Properties.Scheme === 'internet-facing',
  albLb.Properties.Scheme,
);
const albPublicSubnets = Object.keys(alb.Resources).filter((k) =>
  /publicSubnet\d+Subnet/i.test(k),
);
const albLbSubnets = JSON.stringify(albLb.Properties.Subnets);
ok(
  'alb: LB sits in the public subnets',
  albPublicSubnets.length > 0 &&
    albPublicSubnets.every((s) => albLbSubnets.includes(s)),
  albLbSubnets,
);
const albListeners = byType('AWS::ElasticLoadBalancingV2::Listener', alb);
ok('alb: exactly 1 listener', albListeners.length === 1);
const albL = albListeners[0][1].Properties;
ok(
  'alb: listener HTTPS:443',
  albL.Protocol === 'HTTPS' && albL.Port === 443,
  `${albL.Protocol}:${albL.Port}`,
);
ok(
  'alb: regional certificate attached to the listener',
  JSON.stringify(albL.Certificates || []).includes(
    `arn:aws:acm:${ALB_CERT_REGION}`,
  ),
  JSON.stringify(albL.Certificates),
);
ok(
  'alb: default action is a 403 fixed response',
  albL.DefaultActions?.[0]?.FixedResponseConfig?.StatusCode === '403',
  JSON.stringify(albL.DefaultActions),
);
const albRules = byType('AWS::ElasticLoadBalancingV2::ListenerRule', alb);
ok(
  'alb: 2 listener rules (ALB DNS p1 + custom domain p2)',
  albRules.length === 2,
  albRules.map(([k, r]) => `${k}:p${r.Properties.Priority}`).join(','),
);
ok(
  'alb: both rules match on host-header',
  albRules.length > 0 &&
    albRules.every(([, r]) =>
      r.Properties.Conditions.every((c) => (c.Field ?? c.field) === 'host-header'),
    ),
);
ok(
  'alb: HasCustomDomain condition present',
  Object.keys(alb.Conditions || {}).some((k) => k.includes('HasCustomDomain')),
  Object.keys(alb.Conditions || {}).join(','),
);
ok(
  'alb: the custom-domain rule is gated on that condition',
  albRules.some(([, r]) => String(r.Condition || '').includes('HasCustomDomain')),
);
ok(
  'alb: zero CloudFront resources of any kind',
  !Object.values(alb.Resources).some((r) => r.Type.startsWith('AWS::CloudFront::')),
  Object.values(alb.Resources)
    .map((r) => r.Type)
    .filter((t) => t.startsWith('AWS::CloudFront::'))
    .join(','),
);

console.log('--- backwards compatibility: alb template identical to the pre-change commit ---');
const ids = (t) => Object.keys(t.Resources).sort();
const typed = (t) =>
  Object.entries(t.Resources)
    .map(([k, r]) => `${k}=${r.Type}`)
    .sort();
const a = ids(alb);
const b = ids(base);
ok(
  'alb: same logical ID set as the baseline',
  JSON.stringify(a) === JSON.stringify(b),
  `count=${a.length}/${b.length} added=[${a.filter((x) => !b.includes(x))}] removed=[${b.filter(
    (x) => !a.includes(x),
  )}]`,
);
ok(
  'alb: same logicalId->Type map as the baseline',
  JSON.stringify(typed(alb)) === JSON.stringify(typed(base)),
);
ok(
  'alb: load balancer keeps its baseline logical ID',
  byType('AWS::ElasticLoadBalancingV2::LoadBalancer', base).every(([k]) =>
    Object.keys(alb.Resources).includes(k),
  ),
  byType('AWS::ElasticLoadBalancingV2::LoadBalancer', base)
    .map(([k]) => k)
    .join(','),
);
ok(
  'alb: listener keeps its baseline logical ID',
  byType('AWS::ElasticLoadBalancingV2::Listener', base).every(([k]) =>
    Object.keys(alb.Resources).includes(k),
  ),
  byType('AWS::ElasticLoadBalancingV2::Listener', base)
    .map(([k]) => k)
    .join(','),
);
ok(
  'alb: same Outputs set as the baseline',
  JSON.stringify(Object.keys(alb.Outputs || {}).sort()) ===
    JSON.stringify(Object.keys(base.Outputs || {}).sort()),
  Object.keys(alb.Outputs || {}).join(','),
);
ok(
  'alb: same Conditions set as the baseline',
  JSON.stringify(Object.keys(alb.Conditions || {}).sort()) ===
    JSON.stringify(Object.keys(base.Conditions || {}).sort()),
);
// Full property-level diff. Two values legitimately differ run to run / tree to
// tree and are normalised: the bcrypt salt (random per synth) and any 64-hex
// digest (the Docker image asset hash, which follows unrelated repo content).
// Resource ordering is normalised too — CloudFormation does not interpret the
// key order of `Resources`, so a reshuffle is not a change.
const norm = (t) =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(t.Resources)
        .sort()
        .map((k) => [k, t.Resources[k]]),
    ),
  )
    .replace(/[0-9a-f]{64}/g, '<HASH>')
    .replace(/\$2[aby]\$\d\d\$[^\\"]+/g, '<BCRYPT>');
ok(
  'alb: every resource byte-identical to the baseline (bcrypt salt + asset hashes normalised)',
  norm(alb) === norm(base),
);
ok(
  'alb: Outputs identical to the baseline',
  JSON.stringify(alb.Outputs) === JSON.stringify(base.Outputs),
);
ok(
  'alb: Conditions identical to the baseline',
  JSON.stringify(alb.Conditions) === JSON.stringify(base.Conditions),
);

console.log('--- cloudfront mode: internal ALB in private subnets, HTTP:80 -> target group ---');
const cfLb = one('AWS::ElasticLoadBalancingV2::LoadBalancer', cf);
ok('cf: Scheme=internal', cfLb.Properties.Scheme === 'internal', cfLb.Properties.Scheme);
const privateSubnets = Object.keys(cf.Resources).filter((k) =>
  /privateSubnet\d+Subnet/i.test(k),
);
const lbSubnets = JSON.stringify(cfLb.Properties.Subnets);
ok(
  'cf: LB subnets are the private subnets only',
  privateSubnets.length > 0 &&
    privateSubnets.every((s) => lbSubnets.includes(s)) &&
    !/publicSubnet/i.test(lbSubnets),
  lbSubnets,
);
const cfListeners = byType('AWS::ElasticLoadBalancingV2::Listener', cf);
ok('cf: exactly 1 listener', cfListeners.length === 1);
const cfL = cfListeners[0][1].Properties;
ok(
  'cf: listener HTTP:80',
  cfL.Protocol === 'HTTP' && cfL.Port === 80,
  `${cfL.Protocol}:${cfL.Port}`,
);
ok('cf: no listener certificates', !cfL.Certificates);
const tgIds = byType('AWS::ElasticLoadBalancingV2::TargetGroup', cf).map(([k]) => k);
ok(
  'cf: default action forwards to the service target group',
  cfL.DefaultActions?.length === 1 &&
    cfL.DefaultActions[0].Type === 'forward' &&
    tgIds.includes(cfL.DefaultActions[0].TargetGroupArn?.Ref),
  JSON.stringify(cfL.DefaultActions),
);
ok(
  'cf: no host-header listener rules (a private ALB behind one distribution needs none)',
  byType('AWS::ElasticLoadBalancingV2::ListenerRule', cf).length === 0,
);
ok(
  'cf: listener keeps the same logical ID as alb mode (no extra construct scope)',
  cfListeners[0][0] === albListeners[0][0],
  `${cfListeners[0][0]} vs ${albListeners[0][0]}`,
);

console.log('--- cloudfront mode: ALB security group admits inbound :80 ---');
const lbSgId = cfLb.Properties.SecurityGroups.map(
  (s) => s['Fn::GetAtt']?.[0] ?? s.Ref,
).find(Boolean);
const lbSg = cf.Resources[lbSgId];
const ingress80 = (lbSg.Properties.SecurityGroupIngress || []).filter(
  (r) => r.FromPort === 80 && r.ToPort === 80,
);
const standalone80 = byType('AWS::EC2::SecurityGroupIngress', cf).filter(
  ([, r]) =>
    r.Properties.FromPort === 80 &&
    r.Properties.GroupId?.['Fn::GetAtt']?.[0] === lbSgId,
);
ok(
  'cf: LB security group has an inbound port-80 rule',
  ingress80.length + standalone80.length > 0,
  JSON.stringify(ingress80),
);

console.log('--- cloudfront mode: exactly one distribution with a VPC origin ---');
const dists = byType('AWS::CloudFront::Distribution', cf);
ok('cf: exactly 1 AWS::CloudFront::Distribution', dists.length === 1);
const dc = dists[0][1].Properties.DistributionConfig;
ok('cf: exactly 1 origin', dc.Origins.length === 1);
const origin = dc.Origins[0];
const vpcOrigins = byType('AWS::CloudFront::VpcOrigin', cf);
ok('cf: exactly 1 AWS::CloudFront::VpcOrigin', vpcOrigins.length === 1);
ok(
  'cf: origin uses VpcOriginConfig pointing at that VpcOrigin',
  origin.VpcOriginConfig?.VpcOriginId?.['Fn::GetAtt']?.[0] === vpcOrigins[0][0],
  JSON.stringify(origin.VpcOriginConfig),
);
const vo = vpcOrigins[0][1].Properties.VpcOriginEndpointConfig;
const cfLbId = Object.keys(cf.Resources).find((k) => cf.Resources[k] === cfLb);
ok(
  'cf: the VPC origin endpoint is the load balancer',
  vo.Arn?.Ref === cfLbId,
  JSON.stringify(vo.Arn),
);
ok(
  'cf: origin DomainName is the LB DNS name',
  JSON.stringify(origin.DomainName).includes('DNSName'),
  JSON.stringify(origin.DomainName),
);
ok(
  'cf: no CustomOriginConfig / S3OriginConfig on the origin',
  !origin.CustomOriginConfig && !origin.S3OriginConfig,
);
ok(
  'cf: VPC origin talks http-only on port 80',
  vo.OriginProtocolPolicy === 'http-only' && vo.HTTPPort === 80,
  `${vo.OriginProtocolPolicy}:${vo.HTTPPort}`,
);

console.log('--- cloudfront mode: caching disabled, all methods, all-viewer, redirect-to-https ---');
const db = dc.DefaultCacheBehavior;
ok(
  'cf: ViewerProtocolPolicy=redirect-to-https',
  db.ViewerProtocolPolicy === 'redirect-to-https',
  db.ViewerProtocolPolicy,
);
ok(
  'cf: allowed methods are all 7',
  JSON.stringify(db.AllowedMethods) ===
    JSON.stringify(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']),
  JSON.stringify(db.AllowedMethods),
);
ok(
  'cf: CachePolicyId is the managed CachingDisabled policy',
  db.CachePolicyId === '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
  db.CachePolicyId,
);
ok(
  'cf: OriginRequestPolicyId is the managed AllViewer policy',
  db.OriginRequestPolicyId === '216adef6-5c7f-47e4-b989-5492eafa07d3',
  db.OriginRequestPolicyId,
);
ok('cf: no cache behaviours besides the default', !dc.CacheBehaviors);

console.log('--- cloudfront mode: 60s origin read timeout, no response completion timeout ---');
ok(
  'cf: OriginReadTimeout=60',
  origin.VpcOriginConfig.OriginReadTimeout === 60,
  String(origin.VpcOriginConfig.OriginReadTimeout),
);
ok(
  'cf: no OriginKeepaliveTimeout emitted (CDK default 5s)',
  origin.VpcOriginConfig.OriginKeepaliveTimeout === undefined,
);
ok(
  'cf: template mentions no ResponseCompletionTimeout anywhere',
  !JSON.stringify(cf).includes('ResponseCompletionTimeout'),
);

console.log('--- cloudfront mode without a certificate: default CloudFront cert, no alias ---');
const dcNo = one('AWS::CloudFront::Distribution', cfNo).Properties.DistributionConfig;
ok('cf-nocert: no Aliases', dcNo.Aliases === undefined, JSON.stringify(dcNo.Aliases));
ok(
  'cf-nocert: no viewer certificate ARN (falls back to the default CloudFront cert)',
  dcNo.ViewerCertificate === undefined || !dcNo.ViewerCertificate.AcmCertificateArn,
  JSON.stringify(dcNo.ViewerCertificate),
);
ok(
  'cf-nocert: no ACM certificate ARN anywhere in the distribution',
  !JSON.stringify(dcNo).includes('arn:aws:acm'),
);

console.log('--- cloudfront mode with domain + us-east-1 certificate: alias + cert reference ---');
ok(
  `cf: Aliases=[${CF_DOMAIN}]`,
  JSON.stringify(dc.Aliases) === JSON.stringify([CF_DOMAIN]),
  JSON.stringify(dc.Aliases),
);
ok(
  'cf: ViewerCertificate references the us-east-1 certificate',
  dc.ViewerCertificate?.AcmCertificateArn === CF_CERT_ARN,
  JSON.stringify(dc.ViewerCertificate),
);
ok('cf: SNI only', dc.ViewerCertificate?.SslSupportMethod === 'sni-only');

console.log('--- public URL derivation per mode + distribution domain output ---');
const nextAuthUrl = (tpl) => {
  const td = one('AWS::ECS::TaskDefinition', tpl);
  const env = td.Properties.ContainerDefinitions[0].Environment;
  return env.find((e) => e.Name === 'NEXTAUTH_URL').Value;
};
const albUrl = nextAuthUrl(alb);
ok(
  'alb: NEXTAUTH_URL = https:// + Fn::If(HasCustomDomain, domain, LB DNS)',
  JSON.stringify(albUrl).includes('Fn::If') &&
    JSON.stringify(albUrl).includes('HasCustomDomain') &&
    JSON.stringify(albUrl).includes('DNSName'),
  JSON.stringify(albUrl),
);
ok(
  'alb: portalURL output === NEXTAUTH_URL',
  JSON.stringify(alb.Outputs.portalURL.Value) === JSON.stringify(albUrl),
);
const cfUrl = nextAuthUrl(cf);
ok(
  `cf(domain): NEXTAUTH_URL = https://${CF_DOMAIN}`,
  cfUrl === `https://${CF_DOMAIN}`,
  JSON.stringify(cfUrl),
);
ok(
  'cf(domain): portalURL output === NEXTAUTH_URL',
  JSON.stringify(cf.Outputs.portalURL.Value) === JSON.stringify(cfUrl),
);
const cfNoUrl = nextAuthUrl(cfNo);
const noDistId = byType('AWS::CloudFront::Distribution', cfNo)[0][0];
ok(
  'cf(no domain): NEXTAUTH_URL = https:// + distribution DomainName',
  JSON.stringify(cfNoUrl) ===
    JSON.stringify({
      'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [noDistId, 'DomainName'] }]],
    }),
  JSON.stringify(cfNoUrl),
);
ok(
  'cf(no domain): portalURL output === NEXTAUTH_URL',
  JSON.stringify(cfNo.Outputs.portalURL.Value) === JSON.stringify(cfNoUrl),
);
ok(
  'cf: CloudFrontDomainName output = distribution DomainName',
  JSON.stringify(cf.Outputs.CloudFrontDomainName?.Value) ===
    JSON.stringify({ 'Fn::GetAtt': [dists[0][0], 'DomainName'] }),
  JSON.stringify(cf.Outputs.CloudFrontDomainName?.Value),
);
ok('alb: no CloudFrontDomainName output', alb.Outputs.CloudFrontDomainName === undefined);

console.log('--- no Route 53 record or hosted zone in either mode ---');
for (const [name, tpl] of [
  ['alb', alb],
  ['cf-domain', cf],
  ['cf-nocert', cfNo],
]) {
  ok(
    `${name}: no AWS::Route53* resource`,
    !Object.values(tpl.Resources).some((r) => r.Type.startsWith('AWS::Route53')),
    Object.values(tpl.Resources)
      .map((r) => r.Type)
      .filter((t) => t.startsWith('AWS::Route53'))
      .join(','),
  );
}

console.log(
  `\n${fails === 0 ? 'TEMPLATE ASSERTIONS: ALL PASSED' : `TEMPLATE ASSERTIONS: ${fails} FAILED`}`,
);
process.exit(fails === 0 ? 0 : 1);
