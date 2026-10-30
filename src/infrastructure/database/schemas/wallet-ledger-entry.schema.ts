import { EntitySchema } from "@mikro-orm/core";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../domain/entities/wallet-ledger-entry.entity";
import { MoneyType } from "../types/money.type";

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntry>({
  class: WalletLedgerEntry,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { enum: true, items: () => LedgerDirection },
    money: { type: MoneyType, fieldName: "amount" },
    balanceBefore: { type: MoneyType, fieldName: "balance_before_amount" },
    balanceAfter: { type: MoneyType, fieldName: "balance_after_amount" },
    createdAt: { type: "Date", fieldName: "created_at" },
  },
  indexes: [
    {
      name: "idx_ledger_wallet_cursor",
      properties: ["walletId", "createdAt", "id"],
    },
  ],
});

