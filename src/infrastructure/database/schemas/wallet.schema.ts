import { EntitySchema } from "@mikro-orm/core";
import { Wallet } from "../../../domain/entities/wallet.aggregate";
import { MoneyType } from "../types/money.type";

export const WalletSchema = new EntitySchema<Wallet>({
  class: Wallet,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string", length: 3 },
    balance: { type: MoneyType, fieldName: "balance_amount" },
    version: { type: "integer", default: 1 },
    createdAt: { type: "Date", fieldName: "created_at" },
    updatedAt: { type: "Date", fieldName: "updated_at" },
  },
  uniques: [
    {
      name: "uk_wallet_player_currency",
      properties: ["playerId", "currency"],
    },
  ],
});
