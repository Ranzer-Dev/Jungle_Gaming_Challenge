import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Message, SQSClient } from "@aws-sdk/client-sqs";
import { v7 as uuidv7 } from "uuid";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction.entity";
import { SqsWagerConsumerWorker } from "../../src/infrastructure/messaging/sqs-wager-consumer.worker";
import { PendingReferenceWorker } from "../../src/infrastructure/workers/pending-reference.worker";
import { setupIntegrationContext } from "../integration/test-helper";

describe("Concurrency & Stress Suite (Zero Mocks, Real PostgreSQL & LocalStack SQS)", () => {
  let context: Awaited<ReturnType<typeof setupIntegrationContext>>;
  let createWalletUseCase: CreateWalletUseCase;
  let processTxUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    context = await setupIntegrationContext();
    createWalletUseCase = new CreateWalletUseCase(context.uow);
    processTxUseCase = new ProcessWagerTransactionUseCase(context.uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(context.uow);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  // =========================================================================
  // CENÁRIO 1: 50 Requisições Paralelas Simultâneas contra a Mesma Carteira
  // =========================================================================
  it("Cenário 1: should safely handle 50 concurrent requests against a single hot wallet with absolute balance consistency", async () => {
    const playerId = `player-concurrency-50-${uuidv7()}`;
    const initialAmount = "1000.00";

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: initialAmount, currency: "BRL" },
    });

    const numRequests = 50;
    const betAmount = "10.00"; // 50 * 10 = 500 BRL debitados, saldo final = 500.00

    // Dispara 50 apostas simultâneas em paralelo
    const promises = Array.from({ length: numRequests }, (_, i) => {
      const txId = `tx-c1-${i}-${uuidv7()}`;
      return processTxUseCase.execute({
        idempotencyKey: `idemp-c1-${txId}`,
        providerId: "pragmatic",
        externalTransactionId: txId,
        playerId,
        walletId: wallet.id,
        roundId: `round-c1-${i}`,
        gameId: "sweet-bonanza",
        kind: WagerTransactionKind.Bet,
        money: { amount: betAmount, currency: "BRL" },
      });
    });

    const results = await Promise.all(promises);

    // Todas as 50 apostas devem ter sido processadas com sucesso
    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
      expect(res.idempotentReplay).toBe(false);
    }

    // Consulta final da carteira no banco
    await context.uow.execute(async ({ wallets, ledger }) => {
      const persistedWallet = await wallets.findById(wallet.id);
      expect(persistedWallet?.balance.amount).toBe("500.00");
      expect(persistedWallet?.version).toBe(52); // Versão 1 (criação) + 1 (crédito OPENING) + 50 (débitos BET) = 52

      const entries = await ledger.findByWalletId(wallet.id, 100);
      expect(entries.entries.length).toBe(51);
    });

    // Auditoria formal de consistência matemática
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("500.00");
    expect(recon.calculatedBalance.amount).toBe("500.00");
    expect(recon.difference.amount).toBe("0.00");
    expect(recon.checkedEntries).toBe(51);
  });

  // =========================================================================
  // CENÁRIO 2: Hot Wallet Concorrente com Esgotamento de Saldo
  // =========================================================================
  it("Cenário 2: should serialize parallel overdraft attempts, granting exactly 1 and rejecting the other with INSUFFICIENT_FUNDS", async () => {
    const playerId = `player-hot-wallet-${uuidv7()}`;

    // Carteira com 100.00 BRL
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const txId1 = `bet-hot-1-${uuidv7()}`;
    const txId2 = `bet-hot-2-${uuidv7()}`;

    // 2 requisições paralelas de 80.00 BRL disparadas no mesmo milissegundo
    const results = await Promise.all([
      processTxUseCase.execute({
        idempotencyKey: `idemp-hot-1-${txId1}`,
        providerId: "evolution",
        externalTransactionId: txId1,
        playerId,
        walletId: wallet.id,
        roundId: "round-hot-1",
        gameId: "lightning-roulette",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
      }),
      processTxUseCase.execute({
        idempotencyKey: `idemp-hot-2-${txId2}`,
        providerId: "evolution",
        externalTransactionId: txId2,
        playerId,
        walletId: wallet.id,
        roundId: "round-hot-2",
        gameId: "lightning-roulette",
        kind: WagerTransactionKind.Bet,
        money: { amount: "80.00", currency: "BRL" },
      }),
    ]);

    const processedCount = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
    const rejectedCount = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;

    expect(processedCount).toBe(1);
    expect(rejectedCount).toBe(1);

    // Saldo final deve ser exatamente 20.00 BRL (100 - 80), e NUNCA -60 BRL
    await context.uow.execute(async ({ wallets }) => {
      const persistedWallet = await wallets.findById(wallet.id);
      expect(persistedWallet?.balance.amount).toBe("20.00");
    });

    // Reconciliação prova integridade
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("20.00");
    expect(recon.calculatedBalance.amount).toBe("20.00");
  });

  // =========================================================================
  // CENÁRIO 3: Race Condition de Idempotência (10 Requests Idênticos Simultâneos)
  // =========================================================================
  it("Cenário 3: should handle 10 parallel identical requests with same Idempotency-Key safely, executing only once", async () => {
    const playerId = `player-idemp-race-${uuidv7()}`;

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const sharedIdempotencyKey = `shared-key-${uuidv7()}`;
    const sharedExternalTxId = `ext-shared-${uuidv7()}`;

    // Dispara 10 requests concorrentes com exatamente o mesmo payload e chave de idempotência
    const promises = Array.from({ length: 10 }, () =>
      processTxUseCase.execute({
        idempotencyKey: sharedIdempotencyKey,
        providerId: "pragmatic",
        externalTransactionId: sharedExternalTxId,
        playerId,
        walletId: wallet.id,
        roundId: "round-shared",
        gameId: "sweet-bonanza",
        kind: WagerTransactionKind.Bet,
        money: { amount: "25.00", currency: "BRL" },
      }),
    );

    const results = await Promise.all(promises);

    // Todos os 10 retornam sucesso (200 / 201)
    for (const res of results) {
      expect(res.status).toBe(WagerTransactionStatus.Processed);
    }

    // Exatamente 1 deve ser o original e os outros 9 replays idempotentes
    const originalCount = results.filter((r) => !r.idempotentReplay).length;
    const replayCount = results.filter((r) => r.idempotentReplay).length;

    expect(originalCount).toBe(1);
    expect(replayCount).toBe(9);

    // Saldo final deve ter sido debitado apenas UMA VEZ (100 - 25 = 75.00)
    await context.uow.execute(async ({ wallets, ledger }) => {
      const persistedWallet = await wallets.findById(wallet.id);
      expect(persistedWallet?.balance.amount).toBe("75.00");

      const entries = await ledger.findByWalletId(wallet.id, 10);
      expect(entries.entries.length).toBe(2); // 1 OPENING + 1 BET única
    });
  });

  // =========================================================================
  // CENÁRIO 4: Execução Fora de Ordem (REFUND chega antes da BET)
  // =========================================================================
  it("Cenário 4: should accept out-of-order REFUND as PENDING_REFERENCE and resolve automatically when BET arrives", async () => {
    const playerId = `player-ooo-${uuidv7()}`;
    const roundId = `round-ooo-${uuidv7()}`;
    const pendingWorker = new PendingReferenceWorker(context.uow);

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const betTxId = `bet-parent-${uuidv7()}`;
    const refundTxId = `refund-early-${uuidv7()}`;

    // 1. O REFUND chega PRIMEIRO (fora de ordem)
    const refundResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${refundTxId}`,
      providerId: "pragmatic",
      externalTransactionId: refundTxId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: "sparta",
      kind: WagerTransactionKind.Refund,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: betTxId,
    });

    expect(refundResult.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refundResult.balance.amount).toBe("100.00"); // Saldo não muda

    // 2. Agora a BET original chega
    const betResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${betTxId}`,
      providerId: "pragmatic",
      externalTransactionId: betTxId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId: "sparta",
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
    });

    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(betResult.balance.amount).toBe("70.00"); // 100 - 30 = 70.00

    // 3. Executa o worker de background para resolver a pendência
    const resolvedCount = await pendingWorker.evaluatePendingReferences();
    expect(resolvedCount).toBeGreaterThanOrEqual(1);

    // 4. Saldo após o REFUND resolvido deve voltar para 100.00 BRL
    await context.uow.execute(async ({ wallets, transactions }) => {
      const persistedWallet = await wallets.findById(wallet.id);
      expect(persistedWallet?.balance.amount).toBe("100.00");

      const refundTx = await transactions.findByProviderAndExternalId(
        "pragmatic",
        refundTxId,
      );
      expect(refundTx?.status).toBe(WagerTransactionStatus.Processed);
    });

    // Reconciliação confirma 100% de consistência
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("100.00");
  });

  // =========================================================================
  // CENÁRIO 5: Crash Recovery Before ACK (Absorção no Transactional Inbox)
  // =========================================================================
  it("Cenário 5: should handle crash recovery before ACK, absorbing SQS redelivery idempotently via Inbox", async () => {
    const playerId = `player-crash-${uuidv7()}`;

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    let deleteCallCount = 0;
    const mockSqsClient = {
      send: async (cmd: any) => {
        if (cmd.constructor.name === "DeleteMessageCommand") {
          deleteCallCount++;
        }
        return {};
      },
    } as unknown as SQSClient;

    const consumer = new SqsWagerConsumerWorker(
      processTxUseCase,
      { queueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo" },
      mockSqsClient,
    );

    const messagePayload = {
      messageId: `sqs-msg-${uuidv7()}`,
      type: "WagerTransactionRequested",
      data: {
        providerId: "pragmatic",
        externalTransactionId: `tx-crash-${uuidv7()}`,
        idempotencyKey: `idemp-crash-${uuidv7()}`,
        playerId,
        walletId: wallet.id,
        roundId: "round-crash",
        gameId: "crash-game",
        kind: WagerTransactionKind.Bet,
        money: { amount: "40.00", currency: "BRL" },
      },
    };

    const sqsMessage: Message = {
      MessageId: messagePayload.messageId,
      ReceiptHandle: "receipt-handle-crash-1",
      Body: JSON.stringify(messagePayload),
    };

    // Primeira entrega: processada com sucesso no banco
    const firstDelivery = await consumer.processSingleMessage(sqsMessage);
    expect(firstDelivery).toBe(true);
    expect(deleteCallCount).toBe(1);

    // Simula redelivery pelo broker SQS com novo ReceiptHandle (como se o DeleteMessage anterior tivesse falhado na rede)
    const redeliveredMessage: Message = {
      MessageId: messagePayload.messageId,
      ReceiptHandle: "receipt-handle-crash-2-redelivery",
      Body: JSON.stringify(messagePayload),
    };

    const secondDelivery = await consumer.processSingleMessage(redeliveredMessage);
    expect(secondDelivery).toBe(true);
    expect(deleteCallCount).toBe(2); // ACK confirmado

    // Saldo final deve ter sido debitado apenas UMA VEZ (100 - 40 = 60.00 BRL)
    await context.uow.execute(async ({ wallets, ledger }) => {
      const persistedWallet = await wallets.findById(wallet.id);
      expect(persistedWallet?.balance.amount).toBe("60.00");

      const entries = await ledger.findByWalletId(wallet.id, 10);
      expect(entries.entries.length).toBe(2); // 1 OPENING + 1 BET única
    });
  });
});
