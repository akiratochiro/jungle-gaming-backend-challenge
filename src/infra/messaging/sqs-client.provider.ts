import { Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadMessagingConfig, MessagingConfig } from './messaging.config';

@Injectable()
export class SqsClientProvider {
  readonly config: MessagingConfig;
  readonly client: SQSClient;

  constructor() {
    this.config = loadMessagingConfig();
    this.client = new SQSClient({
      region: this.config.region,
      ...(this.config.endpoint ? { endpoint: this.config.endpoint } : {}),
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  async healthCheck(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.config.requestQueueUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
  }

  /** Publish one message to a FIFO queue. `dedupId` makes redelivery idempotent. */
  async sendFifo(params: {
    queueUrl: string;
    body: string;
    groupId: string;
    dedupId: string;
    attributes?: Record<string, string>;
  }): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: params.queueUrl,
        MessageBody: params.body,
        MessageGroupId: params.groupId,
        MessageDeduplicationId: params.dedupId,
        ...(params.attributes
          ? {
              MessageAttributes: Object.fromEntries(
                Object.entries(params.attributes).map(([k, v]) => [
                  k,
                  { DataType: 'String', StringValue: v },
                ]),
              ),
            }
          : {}),
      }),
    );
  }

  async receive(queueUrl: string, max: number, waitSeconds: number, visibilitySeconds: number) {
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All'],
      }),
    );
    return (out.Messages ?? []) as Message[];
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    timeoutSeconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds,
      }),
    );
  }
}
