import { Construct } from 'constructs';
import {
  Aws,
  Duration,
  Fn,
  CfnCondition,
  CfnOutput,
  aws_ecs as ecs,
  aws_ec2 as ec2,
  aws_elasticloadbalancingv2 as elbv2,
  aws_logs as logs,
  aws_iam as iam,
  aws_ecr_assets as ecr_assets,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
} from 'aws-cdk-lib';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCondition,
  ListenerCertificate,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import path from 'path';
import { Database, DB_NAME } from './database';
import { Network } from './network';
import { Cache } from './cache';
import { DeployMode } from './deploy-mode';

const SERVICE_PORT = 8637;

export interface ServiceProps {
  readonly vpc: ec2.IVpc;
  readonly networkStack: Network;
  readonly database: Database;
  readonly cache?: Cache;
  /**
   * Front-door topology. `alb` keeps the internet-facing HTTPS load balancer;
   * `cloudfront` puts an internal load balancer behind a CloudFront VPC origin.
   */
  readonly deployMode: DeployMode;
  readonly acmCertificateArn: string;
  readonly customDomain: string;
  readonly desiredCount?: number;
  readonly taskCpu?: number;
  readonly taskMemoryMiB?: number;
}

export class Service extends Construct {
  readonly alb: ApplicationLoadBalancer;
  readonly endpoint: string;

  constructor(scope: Construct, id: string, props: ServiceProps) {
    super(scope, id);

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
    });

    const isCloudFrontMode = props.deployMode === 'cloudfront';

    // In `cloudfront` mode the load balancer is private and reached only through
    // a CloudFront VPC origin; in `alb` mode it stays the public front door.
    // NOTE: in `alb` mode the props below must remain byte-for-byte equivalent to
    // the pre-CloudFront version so the logical ID (ServiceAlbC1AFD770) is stable —
    // an ALB's scheme is immutable and a renamed logical ID is a replacement.
    this.alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: !isCloudFrontMode,
      idleTimeout: Duration.minutes(60),
      ...(isCloudFrontMode
        ? {
            vpcSubnets: {
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
          }
        : {}),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: SERVICE_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200-399',
        interval: Duration.seconds(30),
      },
    });

    if (isCloudFrontMode) {
      // Private ALB behind exactly one distribution: no host-header rules and no
      // 403 default are needed, because there is no public listener to protect.
      // `open` is left at its default `true` so the ALB security group admits
      // port 80 from inside the VPC / the CloudFront VPC origin. A listener with
      // `open: false` would synth cleanly and fail every request at runtime.
      this.alb.addListener('Listener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });

      const hasAlternateDomain = Boolean(
        props.customDomain && props.acmCertificateArn,
      );

      const distribution = new cloudfront.Distribution(this, 'Distribution', {
        comment: 'Chorus front door',
        defaultBehavior: {
          origin: origins.VpcOrigin.withApplicationLoadBalancer(this.alb, {
            // 60s (max without an approved quota increase) so the 30s SSE
            // heartbeat is not racing the origin response timeout.
            // `keepaliveTimeout` stays at its default; `VpcOriginProps` exposes
            // no response-completion timeout, which is what would kill SSE.
            readTimeout: Duration.seconds(60),
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
          }),
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // Without both a domain and a us-east-1 certificate, fall back to the
        // default CloudFront certificate on *.cloudfront.net.
        ...(hasAlternateDomain
          ? {
              domainNames: [props.customDomain],
              certificate: Certificate.fromCertificateArn(
                this,
                'CloudFrontCertificate',
                props.acmCertificateArn,
              ),
            }
          : {}),
      });

      // `distribution.domainName` is a CloudFormation attribute reference, so a
      // single deploy pass yields a working NEXTAUTH_URL / OIDC callback.
      this.endpoint = Fn.join('', [
        'https://',
        hasAlternateDomain ? props.customDomain : distribution.domainName,
      ]);

      new CfnOutput(this, 'CloudFrontDomainName', {
        description:
          'CloudFront distribution domain name — the public endpoint when no custom domain is set, otherwise the CNAME target for the custom domain',
        value: distribution.domainName,
      }).overrideLogicalId('CloudFrontDomainName');
    } else {
      const listenerCertificate = ListenerCertificate.fromArn(
        props.acmCertificateArn,
      );

      const listener = this.alb.addListener('Listener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [listenerCertificate],
      });

      const hasCustomDomain = new CfnCondition(this, 'HasCustomDomain', {
        expression: Fn.conditionNot(Fn.conditionEquals(props.customDomain, '')),
      });

      // ALB DNS rule (priority 1)
      listener.addAction('AlbDnsRule', {
        conditions: [
          ListenerCondition.hostHeaders([this.alb.loadBalancerDnsName]),
        ],
        action: ListenerAction.forward([targetGroup]),
        priority: 1,
      });

      // Default 403
      listener.addAction('DefaultAction', {
        action: ListenerAction.fixedResponse(403, {
          contentType: 'text/plain',
          messageBody: 'Forbidden: Access denied',
        }),
      });

      // Conditional custom domain rule (priority 2)
      const cfnListenerRule = new elbv2.CfnListenerRule(
        this,
        'CustomDomainRule',
        {
          actions: [
            {
              type: 'forward',
              targetGroupArn: targetGroup.targetGroupArn,
            },
          ],
          conditions: [
            {
              field: 'host-header',
              values: [props.customDomain],
            },
          ],
          listenerArn: listener.listenerArn,
          priority: 2,
        },
      );
      cfnListenerRule.cfnOptions.condition = hasCustomDomain;

      // Determine NEXTAUTH_URL at deploy time
      const endpointBase = Fn.conditionIf(
        hasCustomDomain.logicalId,
        props.customDomain,
        this.alb.loadBalancerDnsName,
      ).toString();
      this.endpoint = Fn.join('', ['https://', endpointBase]);
    }

    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // Grant execution role read access to secrets
    props.database.dbCredentialSecret.grantRead(taskExecutionRole);
    props.database.appConfigSecret.grantRead(taskExecutionRole);
    if (props.cache) {
      props.cache.redisSecret.grantRead(taskExecutionRole);
    }

    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'TaskDefinition',
      {
        cpu: props.taskCpu ?? 1024,
        memoryLimitMiB: props.taskMemoryMiB ?? 2048,
        executionRole: taskExecutionRole,
      },
    );

    // Docker image from project root (../../.. from packages/chorus-cdk/lib/)
    const containerImage = ecs.ContainerImage.fromDockerImageAsset(
      new ecr_assets.DockerImageAsset(this, 'Image', {
        directory: path.join(__dirname, '../../..'),
        file: 'Dockerfile',
        platform: ecr_assets.Platform.LINUX_AMD64,
        exclude: [
          'packages',
          'node_modules',
          '.git',
          '.next',
          '.env',
          '.env.*',
          '!.env.example',
        ],
      }),
    );

    const container = taskDefinition.addContainer('App', {
      image: containerImage,
      memoryLimitMiB: props.taskMemoryMiB ?? 2048,
      environment: {
        REGION: Aws.REGION,
        DB_NAME: DB_NAME,
        DB_HOST: props.database.dbEndpointAddress,
        DB_PORT: props.database.dbEndpointPort,
        NEXTAUTH_URL: this.endpoint,
        ...(props.cache ? {
          REDIS_HOST: props.cache.redisEndpoint,
          REDIS_PORT: props.cache.redisPort,
          REDIS_USERNAME: 'chorus',
        } : {}),
      },
      secrets: {
        DB_USERNAME: Secret.fromSecretsManager(
          props.database.dbCredentialSecret,
          'username',
        ),
        DB_PASSWORD: Secret.fromSecretsManager(
          props.database.dbCredentialSecret,
          'password',
        ),
        SUPER_ADMIN_EMAIL: Secret.fromSecretsManager(
          props.database.appConfigSecret,
          'SUPER_ADMIN_EMAIL',
        ),
        SUPER_ADMIN_PASSWORD_HASH: Secret.fromSecretsManager(
          props.database.appConfigSecret,
          'SUPER_ADMIN_PASSWORD_HASH',
        ),
        NEXTAUTH_SECRET: Secret.fromSecretsManager(
          props.database.appConfigSecret,
          'NEXTAUTH_SECRET',
        ),
        ...(props.cache ? {
          REDIS_PASSWORD: Secret.fromSecretsManager(
            props.cache.redisSecret,
            'password',
          ),
        } : {}),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'chorus',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    container.addPortMappings({
      containerPort: SERVICE_PORT,
    });

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount ?? 2,
      circuitBreaker: { rollback: true },
      securityGroups: [props.networkStack.serviceSecurityGroup],
      vpcSubnets: props.networkStack.vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
    });

    service.node.addDependency(props.database.dbResource);

    targetGroup.addTarget(service);

    new CfnOutput(this, 'portalURL', {
      description: 'Portal URL',
      value: this.endpoint,
    }).overrideLogicalId('portalURL');

    new CfnOutput(this, 'AlbDnsName', {
      description: isCloudFrontMode
        ? 'DNS name of the internal ALB (CloudFront origin, not publicly reachable)'
        : 'DNS name for ALB, should be the CNAME target of custom domain',
      value: this.alb.loadBalancerDnsName,
    }).overrideLogicalId('AlbDnsName');
  }
}
