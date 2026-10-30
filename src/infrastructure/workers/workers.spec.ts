import { describe, expect, it } from "bun:test";
import {
  IInboxRepository,
  IMessageQueuePublisher,
  IOutboxRepository,
  IUnitOfWork,
  IUnitOfWorkContext,
  IWagerTransactionRepository,
  IWalletLedgerRepository,
  IWalletRepository,
} from "../../application/ports";
import { InboxMessage } from "../../domain/entities/inbox-message.entity";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction.entity";
import { Wallet } from "../../domain/entities/wallet.aggregate";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import { WagerTransactionProcessed } from "../../domain/events/wager-integration-events";
import { Money } from "../../domain/value-objects/money.value-object";
import { OutboxPublisherWorker } from "./outbox-publisher.worker";
import { PendingReferenceWorker } from "./pending-reference.worker";

class InMemoryUoW extends IUnitOfWork {
  public walletsList: Wallet[] = [];
  public transactionsList: WagerTransaction[] = [];
  public ledgersList: WalletLedgerEntry[] = [];
  public outboxList: OutboxMessage[] = [];
  public inboxList: InboxMessage[] = [];

  constructor() {
    super();
  }

  public async execute<T>(
    operation: (uowContext: IUnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    const wallets: IWalletRepository = {
      findById: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByIdForUpdate: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByPlayerAndCurrency: async (playerId, currency) =>
        this.walletsList.find((w) => w.playerId === playerId && w.currency === currency) ??
        null,
      persist: (w) => {
        const idx = this.walletsList.findIndex((item) => item.id === w.id);
        if (idx >= 0) this.walletsList[idx] = w;
        else this.walletsList.push(w);
      },
    };

    const transactions: IWagerTransactionRepository = {
      findById: async (id) => this.transactionsList.find((t) => t.id === id) ?? null,
      findByIdempotencyKey: async (key) =>
        this.transactionsList.find((t) => t.idempotencyKey === key) ?? null,
      findByProviderAndExternalId: async (providerId, externalId) =>
        this.transactionsList.find(
          (t) =>
            t.providerId === providerId && t.externalTransactionId === externalId,
        ) ?? null,
      findPendingReferences: async (limit = 20) =>
        this.transactionsList
          .filter((t) => t.status === WagerTransactionStatus.PendingReference)
          .slice(0, limit),
      persist: (t) => {
        const idx = this.transactionsList.findIndex((item) => item.id === t.id);
        if (idx >= 0) this.transactionsList[idx] = t;
        else this.transactionsList.push(t);
      },
    };

    const ledger: IWalletLedgerRepository = {
      persist: (entry) => {
        this.ledgersList.push(entry);
      },
      findByWalletId: async (walletId, limit = 20, cursor) => {
        const entries = this.ledgersList.filter((e) => e.walletId === walletId);
        return { entries, nextCursor: undefined, hasMore: false };
      },
      sumCreditsAndDebits: async (walletId) => {
        const wallet = this.walletsList.find((w) => w.id === walletId);
        const currency = wallet?.currency ?? "BRL";
        let totalCredits = Money.zero(currency);
        let totalDebits = Money.zero(currency);
        for (const e of this.ledgersList.filter((l) => l.walletId === walletId)) {
          if (e.direction === "CREDIT") totalCredits = totalCredits.add(e.money);
          else totalDebits = totalDebits.add(e.money);
        }
        return {
          totalCredits: totalCredits.amount,
          totalDebits: totalDebits.amount,
          count: this.ledgersList.filter((l) => l.walletId === walletId).length,
        };
      },
    };

    const inbox: IInboxRepository = {
      find: async (c, m) =>
        this.inboxList.find((i) => i.consumerName === c && i.messageId === m) ?? null,
      persist: (msg) => {
        this.inboxList.push(msg);
      },
    };

    const outbox: IOutboxRepository = {
      persist: (msg) => {
        const idx = this.outboxList.findIndex((item) => item.id === msg.id);
        if (idx >= 0) this.outboxList[idx] = msg;
        else this.outboxList.push(msg);
      },
      findPending: async (limit) => {
        return this.outboxList.filter((m) => m.isPending()).slice(0, limit);
      },
    };

    return operation({ wallets, transactions, ledger, inbox, outbox });
  }
}

describe("Worker Components", () => {
  describe("OutboxPublisherWorker", () => {
    it("should fetch pending outbox events, publish to broker, and mark published", async () => {
      const uow = new InMemoryUoW();

      const event = new WagerTransactionProcessed({
        aggregateId: "w-1",
        data: {
          transactionId: "tx-1",
          providerId: "prov-1",
          externalTransactionId: "ext-1",
          playerId: "p-1",
          walletId: "w-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
          processedAt: new Date().toISOString(),
        },
      });

      const outboxMsg = OutboxMessage.enqueue(event);
      uow.outboxList.push(outboxMsg);

      const publishedIds: string[] = [];
      const publisher: IMessageQueuePublisher = {
        publish: async (msg) => {
          publishedIds.push(msg.id);
        },
        publishBatch: async (messages) => {
          const ids = messages.map((m) => m.id);
          publishedIds.push(...ids);
          return { successfulIds: ids, failedIds: [] };
        },
      };

      const worker = new OutboxPublisherWorker(uow, publisher, {
        batchSize: 10,
        pollIntervalMs: 50,
      });

      const count = await worker.processBatch();
      expect(count).toBe(1);
      expect(publishedIds).toContain(outboxMsg.id);
      expect(outboxMsg.publishedAt).toBeDefined();
    });

    it("should schedule retry on failed publish attempts", async () => {
      const uow = new InMemoryUoW();

      const event = new WagerTransactionProcessed({
        aggregateId: "w-1",
        data: {
          transactionId: "tx-2",
          providerId: "prov-1",
          externalTransactionId: "ext-2",
          playerId: "p-1",
          walletId: "w-1",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "5.00", currency: "BRL" },
          processedAt: new Date().toISOString(),
        },
      });

      const outboxMsg = OutboxMessage.enqueue(event);
      uow.outboxList.push(outboxMsg);

      const publisher: IMessageQueuePublisher = {
        publish: async () => {},
        publishBatch: async (messages) => {
          // Simula falha no broker SQS
          return { successfulIds: [], failedIds: messages.map((m) => m.id) };
        },
      };

      const worker = new OutboxPublisherWorker(uow, publisher);
      await worker.processBatch();

      expect(outboxMsg.publishedAt).toBeUndefined();
      expect(outboxMsg.attempts).toBe(1);
      expect(outboxMsg.nextAttemptAt).toBeDefined();
    });
  });

  describe("PendingReferenceWorker", () => {
    it("should resolve PENDING_REFERENCE refund when parent transaction is processed", async () => {
      const uow = new InMemoryUoW();

      const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
      });
      uow.walletsList.push(wallet);

      // Parent BET transaction processed
      const betTx = WagerTransaction.create({
        id: "bet-1",
        providerId: "prov-1",
        externalTransactionId: "ext-bet-1",
        idempotencyKey: "idemp-bet-1",
        payloadHash: "hash-bet-1",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: "20.00", currency: "BRL" }),
      });
      betTx.markProcessed(undefined, wallet.balance);
      uow.transactionsList.push(betTx);

      // Pending REFUND transaction
      const refundTx = WagerTransaction.create({
        id: "refund-1",
        providerId: "prov-1",
        externalTransactionId: "ext-ref-1",
        idempotencyKey: "idemp-ref-1",
        payloadHash: "hash-ref-1",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-1",
        gameId: "game-1",
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: "20.00", currency: "BRL" }),
        referenceExternalTransactionId: "ext-bet-1",
      });
      refundTx.markPendingReference();
      uow.transactionsList.push(refundTx);

      const worker = new PendingReferenceWorker(uow, { pollIntervalMs: 100, maxAgeMs: 60000 });
      const processedCount = await worker.evaluatePendingReferences();

      expect(processedCount).toBe(1);
      expect(refundTx.status).toBe(WagerTransactionStatus.Processed);
      expect(wallet.balance.amount).toBe("70.00"); // 50 + 20
      expect(uow.ledgersList.length).toBe(1);
      expect(uow.outboxList.length).toBe(2); // BalanceChanged + WagerTransactionProcessed
    });

    it("should reject transaction with REFERENCE_NOT_FOUND when maxAgeMs is exceeded", async () => {
      const uow = new InMemoryUoW();

      const wallet = Wallet.open({
        id: "w-2",
        playerId: "p-2",
        initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
      });
      uow.walletsList.push(wallet);

      // Pending REFUND whose parent BET never arrives
      const oldDate = new Date(Date.now() - 70000); // 70s atrás
      const refundTx = WagerTransaction.rehydrate({
        id: "refund-timeout",
        providerId: "prov-1",
        externalTransactionId: "ext-ref-timeout",
        idempotencyKey: "idemp-ref-timeout",
        payloadHash: "hash-ref-timeout",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "round-2",
        gameId: "game-2",
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: "10.00", currency: "BRL" }),
        referenceExternalTransactionId: "non-existent-bet",
        status: WagerTransactionStatus.PendingReference,
        createdAt: oldDate,
      });
      uow.transactionsList.push(refundTx);

      const worker = new PendingReferenceWorker(uow, { maxAgeMs: 60000 });
      await worker.evaluatePendingReferences();

      expect(refundTx.status).toBe(WagerTransactionStatus.Rejected);
      expect(refundTx.failureCode).toBe("REFERENCE_NOT_FOUND");
      expect(uow.outboxList.some((o) => o.eventType === "WagerTransactionRejected")).toBe(true);
    });
  });
});
