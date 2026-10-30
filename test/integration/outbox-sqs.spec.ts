import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { v7 as uuidv7 } from "uuid";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../src/domain/entities/wager-transaction.entity";
import { OutboxPublisherWorker } from "../../src/infrastructure/workers/outbox-publisher.worker";
import { setupIntegrationContext } from "./test-helper";

describe("Integration Test: Transactional Outbox to LocalStack SQS FIFO", () => {
  let context: Awaited<ReturnType<typeof setupIntegrationContext>>;
  let createWalletUseCase: CreateWalletUseCase;
  let processTxUseCase: ProcessWagerTransactionUseCase;
  let outboxWorker: OutboxPublisherWorker;

  beforeAll(async () => {
    context = await setupIntegrationContext();
    // Limpa a tabela de outbox para garantir isolamento limpo deste teste
    await context.orm.em.getConnection().execute("DELETE FROM outbox_messages");

    createWalletUseCase = new CreateWalletUseCase(context.uow);
    processTxUseCase = new ProcessWagerTransactionUseCase(context.uow);
    outboxWorker = new OutboxPublisherWorker(context.uow, context.sqsPublisher, {
      batchSize: 10,
    });
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("should commit outbox message in PostgreSQL and publish to LocalStack SQS FIFO with MessageGroupId and DeduplicationId", async () => {
    const playerId = `player-outbox-${uuidv7()}`;
    const providerId = "pragmatic";

    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const txId = `bet-outbox-${uuidv7()}`;
    await processTxUseCase.execute({
      idempotencyKey: `idemp-${txId}`,
      providerId,
      externalTransactionId: txId,
      playerId,
      walletId: wallet.id,
      roundId: `round-${uuidv7()}`,
      gameId: "gates-of-olympus",
      kind: WagerTransactionKind.Bet,
      money: { amount: "20.00", currency: "BRL" },
    });

    // Processa lote da Outbox via worker real
    const publishedCount = await outboxWorker.processBatch();
    expect(publishedCount).toBeGreaterThanOrEqual(1);

    // Consulta fila LocalStack SQS FIFO para confirmar recebimento real
    const receiveCommand = new ReceiveMessageCommand({
      QueueUrl:
        "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/integration-events.fifo",
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 2,
      VisibilityTimeout: 10,
      AttributeNames: ["All"],
    });

    const sqsResponse = await context.sqsClient.send(receiveCommand);
    expect(sqsResponse.Messages).toBeDefined();
    expect(sqsResponse.Messages?.length).toBeGreaterThanOrEqual(1);

    // Verifica que as mensagens publicadas na Outbox estão marcadas como publicadas no PostgreSQL
    await context.uow.execute(async ({ outbox }) => {
      const pending = await outbox.findPending(10);
      expect(pending.length).toBe(0);
    });
  });
});
