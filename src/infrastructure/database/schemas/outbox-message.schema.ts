import { EntitySchema } from "@mikro-orm/core";
import { OutboxMessage } from "../../../domain/entities/outbox-message.entity";

export const OutboxMessageSchema = new EntitySchema<OutboxMessage>({
  class: OutboxMessage,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "jsonb" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { type: "Date", fieldName: "next_attempt_at", nullable: true },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});
