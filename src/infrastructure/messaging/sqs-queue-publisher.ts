import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
} from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { IMessageQueuePublisher } from "../../application/ports/message-queue-publisher.port";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";

export interface SqsPublisherConfig {
  queueUrl: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class SqsQueuePublisher implements IMessageQueuePublisher {
  private readonly logger = new Logger(SqsQueuePublisher.name);
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;

  constructor(config?: Partial<SqsPublisherConfig>) {
    this.queueUrl =
      config?.queueUrl ||
      process.env.SQS_OUTBOX_QUEUE_URL ||
      "http://localhost:4566/000000000000/integration-events.fifo";

    const endpoint =
      config?.endpoint ||
      process.env.AWS_ENDPOINT ||
      process.env.LOCALSTACK_ENDPOINT ||
      "http://localhost:4566";

    const region = config?.region || process.env.AWS_REGION || "us-east-1";
    const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "test";
    const secretAccessKey =
      config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "test";

    this.sqsClient = new SQSClient({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  public async publish(message: OutboxMessage): Promise<void> {
    const result = await this.publishBatch([message]);
    if (result.failedIds.length > 0) {
      throw new Error(`Failed to publish message ${message.id} to SQS FIFO queue`);
    }
  }

  public async publishBatch(messages: OutboxMessage[]): Promise<{
    successfulIds: string[];
    failedIds: string[];
  }> {
    if (messages.length === 0) {
      return { successfulIds: [], failedIds: [] };
    }

    // AWS SQS FIFO limita lotes em até 10 mensagens por batch
    const successfulIds: string[] = [];
    const failedIds: string[] = [];

    const chunkSize = 10;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((msg) => ({
        Id: msg.id,
        MessageBody: JSON.stringify(msg.payload),
        MessageGroupId: msg.aggregateId, // Particionamento FIFO por walletId
        MessageDeduplicationId: msg.id, // Deduplicação pelo ID canônico do evento
        MessageAttributes: {
          EventType: {
            DataType: "String",
            StringValue: msg.eventType,
          },
          OccurredAt: {
            DataType: "String",
            StringValue: msg.occurredAt.toISOString(),
          },
        },
      }));

      try {
        const command = new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: entries,
        });

        const response = await this.sqsClient.send(command);

        if (response.Successful) {
          for (const s of response.Successful) {
            if (s.Id) {
              successfulIds.push(s.Id);
            }
          }
        }

        if (response.Failed) {
          for (const f of response.Failed) {
            this.logger.error(
              `SQS publish error for message ${f.Id}: [${f.Code}] ${f.Message}`,
            );
            if (f.Id) {
              failedIds.push(f.Id);
            }
          }
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Fatal batch publish failure to SQS queue: ${errorMsg}`);
        for (const msg of chunk) {
          failedIds.push(msg.id);
        }
      }
    }

    return { successfulIds, failedIds };
  }
}

