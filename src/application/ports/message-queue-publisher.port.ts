import { OutboxMessage } from "../../domain/entities/outbox-message.entity";

export interface IMessageQueuePublisher {
  publish(message: OutboxMessage): Promise<void>;
  publishBatch(messages: OutboxMessage[]): Promise<{
    successfulIds: string[];
    failedIds: string[];
  }>;
}

