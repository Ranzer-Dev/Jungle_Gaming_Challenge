import { EntitySchema } from "@mikro-orm/core";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../domain/entities/wallet-ledger-entry.entity";
import { Wallet } from "../../../domain/entities/wallet.aggregate";
import { WagerTransaction } from "../../../domain/entities/wager-transaction.entity";
import { MoneyType } from "../types/money.type";

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntry>({
  class: WalletLedgerEntry,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: {
      kind: "m:1",
      entity: () => Wallet,
      fieldName: "wallet_id",
      mapToPk: true,
    },
    transactionId: {
      kind: "m:1",
      entity: () => WagerTransaction,
      fieldName: "transaction_id",
      mapToPk: true,
    },
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
