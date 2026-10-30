import { EntitySchema } from "@mikro-orm/core";
import { InboxMessage } from "../../../domain/entities/inbox-message.entity";

export const InboxMessageSchema = new EntitySchema<InboxMessage>({
  class: InboxMessage,
  tableName: "inbox_messages",
  properties: {
    messageId: { type: "string", fieldName: "message_id", primary: true },
    consumerName: { type: "string", fieldName: "consumer_name", primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    receivedAt: { type: "Date", fieldName: "received_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

