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
} from 'aws-cdk-lib';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
  ListenerCondition,
  ListenerCertificate,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-ecs';
import path from 'path';
import { Database, DB_NAME } from './database';
import { Network } from './network';
import { Cache } from './cache';

const SERVICE_PORT = 3000;

export interface ServiceProps {
  readonly vpc: ec2.IVpc;
  readonly networkStack: Network;
  readonly database: Database;
  readonly cache?: Cache;
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

    this.alb = new ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      idleTimeout: Duration.minutes(60),
    });

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

    // Determine NEXTAUTH_URL at deploy time
    const endpointBase = Fn.conditionIf(
      hasCustomDomain.logicalId,
      props.customDomain,
      this.alb.loadBalancerDnsName,
    ).toString();
    this.endpoint = Fn.join('', ['https://', endpointBase]);

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

    const service = new ecs.FargateService(this, 'FargateService', {
      cluster,
      taskDefinition,
      desiredCount: props.desiredCount ?? 1,
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
      description:
        'DNS name for ALB, should be the CNAME target of custom domain',
      value: this.alb.loadBalancerDnsName,
    }).overrideLogicalId('AlbDnsName');
  }
}
