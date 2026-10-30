import { describe, expect, it } from "bun:test";
import { Message, SQSClient } from "@aws-sdk/client-sqs";
import {
  IInboxRepository,
  IOutboxRepository,
  IUnitOfWork,
  IUnitOfWorkContext,
  IWagerTransactionRepository,
  IWalletLedgerRepository,
  IWalletRepository,
} from "../../application/ports/repositories.port";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";
import { Wallet } from "../../domain/entities/wallet.aggregate";
import { Money } from "../../domain/value-objects/money.value-object";
import { SqsWagerConsumerWorker } from "./sqs-wager-consumer.worker";

class InMemoryUoW extends IUnitOfWork {
  public walletsList: Wallet[] = [];

  constructor() {
    super();
  }

  public async execute<T>(
    operation: (uowContext: IUnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    const wallets: IWalletRepository = {
      findById: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByIdForUpdate: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByPlayerAndCurrency: async (p, c) =>
        this.walletsList.find((w) => w.playerId === p && w.currency === c) ?? null,
      persist: (w) => {
        const idx = this.walletsList.findIndex((item) => item.id === w.id);
        if (idx >= 0) this.walletsList[idx] = w;
        else this.walletsList.push(w);
      },
    };

    const transactions: IWagerTransactionRepository = {
      findById: async () => null,
      findByIdempotencyKey: async () => null,
      findByProviderAndExternalId: async () => null,
      findPendingReferences: async () => [],
      persist: () => {},
    };

    const ledger: IWalletLedgerRepository = {
      persist: () => {},
      findByWalletId: async () => ({ entries: [], hasMore: false }),
      sumCreditsAndDebits: async () => ({ totalCredits: "0.00", totalDebits: "0.00", count: 0 }),
    };

    const inbox: IInboxRepository = {
      find: async () => null,
      persist: () => {},
    };

    const outbox: IOutboxRepository = {
      persist: () => {},
      findPending: async () => [],
    };

    return operation({ wallets, transactions, ledger, inbox, outbox });
  }
}

describe("SqsWagerConsumerWorker", () => {
  it("should process incoming valid wager message and delete from SQS (Commit Before ACK)", async () => {
    const uow = new InMemoryUoW();
    const wallet = Wallet.open({
      id: "b1b7ef3c-6cc1-447a-8bc2-108b3e34b15c",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    uow.walletsList.push(wallet);

    const useCase = new ProcessWagerTransactionUseCase(uow);

    let sentDelete = false;
    let deletedHandle = "";

    const mockSqsClient = {
      send: async (command: any) => {
        if (command.constructor.name === "DeleteMessageCommand") {
          sentDelete = true;
          deletedHandle = command.input.ReceiptHandle;
          return {};
        }
        return {};
      },
    } as unknown as SQSClient;

    const worker = new SqsWagerConsumerWorker(
      useCase,
      {
        queueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo",
      },
      mockSqsClient,
    );

    const message: Message = {
      MessageId: "msg-sqs-001",
      ReceiptHandle: "receipt-handle-001",
      Body: JSON.stringify({
        messageId: "msg-sqs-001",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "prov-sqs",
          externalTransactionId: "ext-sqs-001",
          idempotencyKey: "idemp-sqs-001",
          playerId: "p-1",
          walletId: wallet.id,
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Bet,
          money: {
            amount: "30.00",
            currency: "BRL",
          },
        },
      }),
    };

    const processed = await worker.processSingleMessage(message);

    expect(processed).toBe(true);
    expect(sentDelete).toBe(true);
    expect(deletedHandle).toBe("receipt-handle-001");
    expect(wallet.balance.amount).toBe("70.00");
  });

  it("should NOT delete message from SQS if database or use case fails", async () => {
    const uow = new InMemoryUoW();
    const useCase = new ProcessWagerTransactionUseCase(uow);

    // Sobrescreve execute para simular falha transitória de infraestrutura (DB fora do ar)
    useCase.execute = async () => {
      throw new Error("Connection to PostgreSQL failed: connection refused");
    };

    let sentDelete = false;
    const mockSqsClient = {
      send: async () => {
        sentDelete = true;
        return {};
      },
    } as unknown as SQSClient;

    const worker = new SqsWagerConsumerWorker(
      useCase,
      {
        queueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo",
      },
      mockSqsClient,
    );

    const message: Message = {
      MessageId: "msg-sqs-fail",
      ReceiptHandle: "receipt-fail-handle",
      Body: JSON.stringify({
        messageId: "msg-sqs-fail",
        type: "WagerTransactionRequested",
        data: {
          providerId: "prov-sqs",
          externalTransactionId: "ext-sqs-fail",
          idempotencyKey: "idemp-sqs-fail",
          playerId: "p-1",
          walletId: "b1b7ef3c-6cc1-447a-8bc2-108b3e34b15c",
          roundId: "r-1",
          gameId: "g-1",
          kind: WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        },
      }),
    };

    const processed = await worker.processSingleMessage(message);

    expect(processed).toBe(false);
    expect(sentDelete).toBe(false); // Retida no broker para redelivery!
  });
});

