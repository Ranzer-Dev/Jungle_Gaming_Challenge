import { EntitySchema } from "@mikro-orm/core";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/entities/wager-transaction.entity";
import { MoneyType } from "../types/money.type";

export const WagerTransactionSchema = new EntitySchema<WagerTransaction>({
  class: WagerTransaction,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id" },
    gameId: { type: "string", fieldName: "game_id" },
    kind: { enum: true, items: () => WagerTransactionKind },
    money: { type: MoneyType, fieldName: "amount" },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: { enum: true, items: () => WagerTransactionStatus },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    balanceAtProcessed: {
      type: MoneyType,
      fieldName: "balance_at_processed_amount",
      nullable: true,
    },
    createdAt: { type: "Date", fieldName: "created_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
  uniques: [
    {
      name: "uk_wager_tx_provider_external",
      properties: ["providerId", "externalTransactionId"],
    },
    {
      name: "uk_wager_tx_idempotency_key",
      properties: ["idempotencyKey"],
    },
  ],
  indexes: [
    {
      name: "idx_wager_tx_wallet_id",
      properties: ["walletId"],
    },
  ],
});
