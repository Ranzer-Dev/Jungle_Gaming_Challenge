import { defineConfig, PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletSchema } from "./schemas/wallet.schema";
import { WagerTransactionSchema } from "./schemas/wager-transaction.schema";
import { WalletLedgerEntrySchema } from "./schemas/wallet-ledger-entry.schema";
import { InboxMessageSchema } from "./schemas/inbox-message.schema";
import { OutboxMessageSchema } from "./schemas/outbox-message.schema";

export default defineConfig({
  driver: PostgreSqlDriver,
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "jungle",
  password: process.env.DB_PASSWORD || "jungle_secret",
  dbName: process.env.DB_NAME || "wagering_db",
  entities: [
    WalletSchema,
    WagerTransactionSchema,
    WalletLedgerEntrySchema,
    InboxMessageSchema,
    OutboxMessageSchema,
  ],
  extensions: [Migrator],
  migrations: {
    path: "./src/infrastructure/database/migrations",
    transactional: true,
    allOrNothing: true,
  },
  debug: false,
});

