import { describe, expect, it } from "bun:test";
import { CreateWalletUseCase } from "./create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./reconcile-wallet.use-case";
import {
  IInboxRepository,
  IOutboxRepository,
  IUnitOfWork,
  IUnitOfWorkContext,
  IWalletLedgerRepository,
  IWalletRepository,
  IWagerTransactionRepository,
} from "../ports/repositories.port";
import { Wallet } from "../../domain/entities/wallet.aggregate";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction.entity";
import { WalletLedgerEntry } from "../../domain/entities/wallet-ledger-entry.entity";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import { InboxMessage } from "../../domain/entities/inbox-message.entity";
import { Money } from "../../domain/value-objects/money.value-object";
import { InsufficientFundsError } from "../../domain/errors/wallet.errors";
import { IdempotencyPayloadMismatchError } from "../../domain/errors/transaction.errors";

// Mock InMemory UoW para testes unitários da camada de aplicação
class InMemoryUnitOfWork implements IUnitOfWork {
  public wallets = new Map<string, Wallet>();
  public transactions = new Map<string, WagerTransaction>();
  public ledgerEntries: WalletLedgerEntry[] = [];
  public inbox = new Map<string, InboxMessage>();
  public outbox: OutboxMessage[] = [];

  async execute<T>(
    operation: (ctx: IUnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    const walletRepo: IWalletRepository = {
      findById: async (id) => this.wallets.get(id) ?? null,
      findByIdForUpdate: async (id) => this.wallets.get(id) ?? null,
      findByPlayerAndCurrency: async (pId, curr) => {
        for (const w of this.wallets.values()) {
          if (w.playerId === pId && w.currency === curr) return w;
        }
        return null;
      },
      persist: (wallet) => this.wallets.set(wallet.id, wallet),
    };

    const txRepo: IWagerTransactionRepository = {
      findById: async (id) => this.transactions.get(id) ?? null,
      findByIdempotencyKey: async (k) => {
        for (const tx of this.transactions.values()) {
          if (tx.idempotencyKey === k) return tx;
        }
        return null;
      },
      findByProviderAndExternalId: async (pId, extId) => {
        for (const tx of this.transactions.values()) {
          if (
            tx.providerId === pId &&
            tx.externalTransactionId === extId
          )
            return tx;
        }
        return null;
      },
      findPendingReferences: async (limit) => [],
      persist: (tx) => this.transactions.set(tx.id, tx),
    };

    const ledgerRepo: IWalletLedgerRepository = {
      findByWalletId: async (wId) => ({
        entries: this.ledgerEntries.filter((e) => e.walletId === wId),
        hasMore: false,
      }),
      sumCreditsAndDebits: async (wId) => {
        let cred = 0;
        let deb = 0;
        let count = 0;
        for (const e of this.ledgerEntries) {
          if (e.walletId === wId) {
            count++;
            if (e.direction === "CREDIT") cred += Number(e.money.toString());
            else deb += Number(e.money.toString());
          }
        }
        return {
          totalCredits: cred.toFixed(2),
          totalDebits: deb.toFixed(2),
          count,
        };
      },
      persist: (entry) => this.ledgerEntries.push(entry),
    };

    const inboxRepo: IInboxRepository = {
      find: async (cName, msgId) => this.inbox.get(`${cName}:${msgId}`) ?? null,
      persist: (msg) =>
        this.inbox.set(`${msg.consumerName}:${msg.messageId}`, msg),
    };

    const outboxRepo: IOutboxRepository = {
      findPending: async () => this.outbox.filter((m) => m.isPending()),
      persist: (msg) => this.outbox.push(msg),
    };

    return operation({
      wallets: walletRepo,
      transactions: txRepo,
      ledger: ledgerRepo,
      inbox: inboxRepo,
      outbox: outboxRepo,
    });
  }
}

describe("Application Use Cases", () => {
  it("should create wallet with initial balance > 0, producing OPENING transaction and ledger", async () => {
    const uow = new InMemoryUnitOfWork();
    const useCase = new CreateWalletUseCase(uow);

    const result = await useCase.execute({
      playerId: "p-1",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    expect(result.playerId).toBe("p-1");
    expect(result.balance.amount).toBe("100.00");
    expect(result.version).toBe(2); // Inicia em 1 e sobe para 2 no crédito do OPENING

    // Valida que o ledger tem 1 lançamento de CREDIT de 100.00
    expect(uow.ledgerEntries).toHaveLength(1);
    expect(uow.ledgerEntries[0].direction).toBe("CREDIT");
    expect(uow.ledgerEntries[0].money.toString()).toBe("100.00");

    // Valida evento na outbox
    expect(uow.outbox).toHaveLength(1);
    expect(uow.outbox[0].eventType).toBe("WalletBalanceChanged");
  });

  it("should process BET and deduct balance with outbox events", async () => {
    const uow = new InMemoryUnitOfWork();
    const createWallet = new CreateWalletUseCase(uow);
    const processTx = new ProcessWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: "p-2",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const result = await processTx.execute({
      idempotencyKey: "prov-a:tx-bet-1",
      providerId: "prov-a",
      externalTransactionId: "tx-bet-1",
      playerId: "p-2",
      walletId: wallet.id,
      roundId: "round-1",
      gameId: "slots-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "40.00", currency: "BRL" },
    });

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe("60.00");
    expect(result.idempotentReplay).toBe(false);

    // Ledger: 1 OPENING + 1 BET DEBIT = 2
    expect(uow.ledgerEntries).toHaveLength(2);
    expect(uow.ledgerEntries[1].direction).toBe("DEBIT");
  });

  it("should return idempotent replay for identical request", async () => {
    const uow = new InMemoryUnitOfWork();
    const createWallet = new CreateWalletUseCase(uow);
    const processTx = new ProcessWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: "p-3",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const command = {
      idempotencyKey: "prov-a:tx-replay-1",
      providerId: "prov-a",
      externalTransactionId: "tx-replay-1",
      playerId: "p-3",
      walletId: wallet.id,
      roundId: "round-2",
      gameId: "slots-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
    };

    const firstRun = await processTx.execute(command);
    expect(firstRun.idempotentReplay).toBe(false);

    // Segunda chamada idêntica
    const secondRun = await processTx.execute(command);
    expect(secondRun.idempotentReplay).toBe(true);
    expect(secondRun.balance.amount).toBe("70.00"); // Saldo da época

    // Ledger não duplicou: 1 OPENING + 1 BET
    expect(uow.ledgerEntries).toHaveLength(2);
  });

  it("should throw IdempotencyPayloadMismatchError when idempotency key is reused with different payload", async () => {
    const uow = new InMemoryUnitOfWork();
    const createWallet = new CreateWalletUseCase(uow);
    const processTx = new ProcessWagerTransactionUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: "p-4",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    await processTx.execute({
      idempotencyKey: "prov-a:conflict-key",
      providerId: "prov-a",
      externalTransactionId: "tx-conflict-1",
      playerId: "p-4",
      walletId: wallet.id,
      roundId: "round-3",
      gameId: "slots-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });

    // Reuso da mesma chave com valor diferente (30.00)
    expect(
      processTx.execute({
        idempotencyKey: "prov-a:conflict-key",
        providerId: "prov-a",
        externalTransactionId: "tx-conflict-1",
        playerId: "p-4",
        walletId: wallet.id,
        roundId: "round-3",
        gameId: "slots-1",
        kind: WagerTransactionKind.Bet,
        money: { amount: "30.00", currency: "BRL" },
      }),
    ).rejects.toThrow(IdempotencyPayloadMismatchError);
  });

  it("should reconcile wallet and prove mathematical balance consistency", async () => {
    const uow = new InMemoryUnitOfWork();
    const createWallet = new CreateWalletUseCase(uow);
    const processTx = new ProcessWagerTransactionUseCase(uow);
    const reconcile = new ReconcileWalletUseCase(uow);

    const wallet = await createWallet.execute({
      playerId: "p-5",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // Aposta de 40 (saldo vai para 60)
    await processTx.execute({
      idempotencyKey: "prov-a:tx-rec-1",
      providerId: "prov-a",
      externalTransactionId: "tx-rec-1",
      playerId: "p-5",
      walletId: wallet.id,
      roundId: "round-rec",
      gameId: "slots-1",
      kind: WagerTransactionKind.Bet,
      money: { amount: "40.00", currency: "BRL" },
    });

    // Ganho de 50 (saldo vai para 110)
    await processTx.execute({
      idempotencyKey: "prov-a:tx-rec-2",
      providerId: "prov-a",
      externalTransactionId: "tx-rec-2",
      playerId: "p-5",
      walletId: wallet.id,
      roundId: "round-rec",
      gameId: "slots-1",
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
    });

    const reconciliation = await reconcile.execute(wallet.id);

    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe("110.00");
    expect(reconciliation.calculatedBalance.amount).toBe("110.00");
    expect(reconciliation.difference.amount).toBe("0.00");
    expect(reconciliation.checkedEntries).toBe(3); // 1 OPENING + 1 BET + 1 WIN
  });
});

