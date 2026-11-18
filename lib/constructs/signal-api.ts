import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  FORMAT_CONTENT_TYPES,
  SIGNAL_FORMAT_NEEDED,
  SIGNAL_MAX_URI_LENGTH,
  SIGNAL_OBJECT_MISSING,
  SIGNAL_ORIGIN_ID,
  SIGNAL_PATH,
  SIGNAL_STAGE_NAME,
} from '../constants';

export interface SignalApiProps {
  /** The FIFO generation queue the signals go to */
  queue: sqs.IQueue;
}

/**
 * The signal origin: an API Gateway REST API whose one method sends the body to SQS. No Lambda.
 *
 *   POST /signals {uri, format, requestedAt, source}  (the generation message, built by the function)
 *     -> a JSON model checks the shape, else 400
 *     -> SQS SendMessage: MessageBody = the body, MessageGroupId = MessageDeduplicationId = uri,
 *        so a burst of agents on one URI within the 5-minute dedup window is one generation
 *
 * The method requires an API key. CloudFront sends it as the `x-api-key` origin custom header,
 * so the functions and the viewers never hold it, and no cache behavior points at the API.
 */
export class SignalApi extends Construct {
  public readonly api: apigateway.RestApi;
  public readonly origin: cloudfront.IOrigin;

  constructor(scope: Construct, id: string, props: SignalApiProps) {
    super(scope, id);

    const apiKeySecret = new secretsmanager.Secret(this, 'ApiKeySecret', {
      description: 'API key CloudFront sends to the signal API',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
    });

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${cdk.Stack.of(this).stackName}-signal`,
      description: 'cf.beacon signals from the CloudFront Functions to the generation queue',
      endpointTypes: [apigateway.EndpointType.REGIONAL],
      deployOptions: { stageName: SIGNAL_STAGE_NAME },
      defaultMethodOptions: { apiKeyRequired: true },
      cloudWatchRole: false,
    });
    const key = this.api.addApiKey('Key', { value: apiKeySecret.secretValue.unsafeUnwrap() });
    const plan = this.api.addUsagePlan('Plan', { apiStages: [{ api: this.api, stage: this.api.deploymentStage }] });
    plan.addApiKey(key);

    const role = new iam.Role(this, 'ApiToQueueRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    props.queue.grantSendMessages(role);

    const sendMessage = new apigateway.AwsIntegration({
      service: 'sqs',
      path: `${cdk.Aws.ACCOUNT_ID}/${props.queue.queueName}`,
      integrationHttpMethod: 'POST',
      options: {
        credentialsRole: role,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          'application/json': [
            'Action=SendMessage',
            "MessageGroupId=$util.urlEncode($input.path('$.uri'))",
            "MessageDeduplicationId=$util.urlEncode($input.path('$.uri'))",
            'MessageBody=$util.urlEncode($input.body)',
          ].join('&'),
        },
        integrationResponses: [
          { statusCode: '202', responseTemplates: { 'application/json': '{"queued": true}' } },
          { statusCode: '400', selectionPattern: '4\\d{2}', responseTemplates: { 'application/json': '{"queued": false}' } },
          { statusCode: '500', selectionPattern: '5\\d{2}', responseTemplates: { 'application/json': '{"queued": false}' } },
        ],
      },
    });

    // The message the Generator reads. FIFO ids are at most 128 characters.
    const signalModel = this.api.addModel('SignalModel', {
      contentType: 'application/json',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['uri', 'format', 'requestedAt', 'source'],
        additionalProperties: false,
        properties: {
          uri: { type: apigateway.JsonSchemaType.STRING, pattern: '^/\\S*$', maxLength: SIGNAL_MAX_URI_LENGTH },
          format: { type: apigateway.JsonSchemaType.STRING, enum: Object.keys(FORMAT_CONTENT_TYPES) },
          requestedAt: { type: apigateway.JsonSchemaType.INTEGER },
          source: { type: apigateway.JsonSchemaType.STRING, enum: [SIGNAL_FORMAT_NEEDED, SIGNAL_OBJECT_MISSING] },
        },
      },
    });

    this.api.root.addResource(SIGNAL_PATH.replace(/^\//, '')).addMethod('POST', sendMessage, {
      requestValidatorOptions: { validateRequestBody: true, validateRequestParameters: true },
      requestModels: { 'application/json': signalModel },
      methodResponses: [{ statusCode: '202' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // Origin path = /<stage>; the functions beacon SIGNAL_PATH to it.
    this.origin = new origins.RestApiOrigin(this.api, {
      originId: SIGNAL_ORIGIN_ID,
      customHeaders: { 'x-api-key': apiKeySecret.secretValue.unsafeUnwrap() },
    });
  }
}
