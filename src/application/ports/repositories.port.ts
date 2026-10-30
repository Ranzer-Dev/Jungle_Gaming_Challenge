import { Wallet } from "../../domain/entities/wallet.aggregate";
import { WagerTransaction } from "../../domain/entities/wager-transaction.entity";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import { InboxMessage } from "../../domain/entities/inbox-message.entity";

export interface IWalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  persist(wallet: Wallet): void;
}

export interface IWagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findPendingReferences(limit: number): Promise<WagerTransaction[]>;
  persist(transaction: WagerTransaction): void;
}

export interface IWalletLedgerRepository {
  findByWalletId(walletId: string, limit: number, cursor?: string): Promise<{ entries: WalletLedgerEntry[]; nextCursor?: string; hasMore: boolean }>;
  sumCreditsAndDebits(walletId: string): Promise<{ totalCredits: string; totalDebits: string; count: number }>;
  persist(entry: WalletLedgerEntry): void;
}

export interface IInboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  persist(message: InboxMessage): void;
}

export interface IOutboxRepository {
  findPending(limit: number): Promise<OutboxMessage[]>;
  persist(message: OutboxMessage): void;
}

export abstract class IUnitOfWork {
  abstract execute<T>(operation: (uowContext: IUnitOfWorkContext) => Promise<T>): Promise<T>;
}

export interface IUnitOfWorkContext {
  wallets: IWalletRepository;
  transactions: IWagerTransactionRepository;
  ledger: IWalletLedgerRepository;
  inbox: IInboxRepository;
  outbox: IOutboxRepository;
}

