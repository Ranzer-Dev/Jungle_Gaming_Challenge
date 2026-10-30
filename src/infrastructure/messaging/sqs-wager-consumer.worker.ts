import {
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Logger } from "@nestjs/common";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";

export interface SqsConsumerConfig {
  queueUrl?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  maxNumberOfMessages?: number;
  waitTimeSeconds?: number;
  visibilityTimeout?: number;
  consumerName?: string;
}

export interface SqsIncomingMessagePayload {
  messageId: string;
  type: string;
  occurredAt?: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: {
      amount: string;
      currency: string;
    };
    referenceExternalTransactionId?: string;
  };
}

export class SqsWagerConsumerWorker {
  private readonly logger = new Logger(SqsWagerConsumerWorker.name);
  private isRunning = false;
  private loopPromise?: Promise<void>;
  private readonly sqsClient: SQSClient;
  private readonly queueUrl: string;
  private readonly maxNumberOfMessages: number;
  private readonly waitTimeSeconds: number;
  private readonly visibilityTimeout: number;
  private readonly consumerName: string;

  constructor(
    private readonly processTransactionUseCase: ProcessWagerTransactionUseCase,
    config?: SqsConsumerConfig,
    clientOverride?: SQSClient,
  ) {
    this.queueUrl =
      config?.queueUrl ||
      process.env.SQS_INCOMING_QUEUE_URL ||
      "http://localhost:4566/000000000000/wager-transactions.fifo";

    const endpoint =
      config?.endpoint ||
      process.env.AWS_ENDPOINT ||
      process.env.LOCALSTACK_ENDPOINT ||
      "http://localhost:4566";

    const region = config?.region || process.env.AWS_REGION || "us-east-1";
    const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "test";
    const secretAccessKey =
      config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "test";

    this.maxNumberOfMessages = config?.maxNumberOfMessages ?? 10;
    this.waitTimeSeconds = config?.waitTimeSeconds ?? 20;
    this.visibilityTimeout = config?.visibilityTimeout ?? 30;
    this.consumerName = config?.consumerName ?? "sqs-wager-consumer";

    this.sqsClient =
      clientOverride ??
      new SQSClient({
        region,
        endpoint,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger.log(
      `Starting SqsWagerConsumerWorker for queue ${this.queueUrl} (long polling: ${this.waitTimeSeconds}s)`,
    );
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.logger.log("Stopping SqsWagerConsumerWorker gracefully...");
    this.isRunning = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.log("SqsWagerConsumerWorker stopped.");
  }

  public async pollOnce(): Promise<number> {
    const receiveCommand = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: this.maxNumberOfMessages,
      WaitTimeSeconds: this.waitTimeSeconds,
      VisibilityTimeout: this.visibilityTimeout,
      AttributeNames: ["All"],
    });

    const response = await this.sqsClient.send(receiveCommand);
    const messages = response.Messages;

    if (!messages || messages.length === 0) {
      return 0;
    }

    this.logger.debug(`Received ${messages.length} messages from SQS queue`);

    let processedCount = 0;
    for (const msg of messages) {
      const success = await this.processSingleMessage(msg);
      if (success) {
        processedCount++;
      }
    }

    return processedCount;
  }

  public async processSingleMessage(message: Message): Promise<boolean> {
    if (!message.Body || !message.ReceiptHandle) {
      this.logger.warn(`Received message without body or receipt handle: ${message.MessageId}`);
      return false;
    }

    let parsedPayload: SqsIncomingMessagePayload;
    try {
      parsedPayload = JSON.parse(message.Body) as SqsIncomingMessagePayload;
    } catch {
      this.logger.error(
        `Failed to parse message body as JSON for messageId: ${message.MessageId}. Letting redrive policy move to DLQ.`,
      );
      return false;
    }

    if (
      parsedPayload.type !== "WagerTransactionRequested" ||
      !parsedPayload.data ||
      !parsedPayload.data.providerId ||
      !parsedPayload.data.idempotencyKey
    ) {
      this.logger.error(
        `Message ${message.MessageId} does not match WagerTransactionRequested schema`,
      );
      return false;
    }

    const { data } = parsedPayload;
    const messageIdForInbox = message.MessageId || parsedPayload.messageId;

    try {
      // 1. Processa a aposta via Caso de Uso (reutilizando exatamente a mesma lógica do HTTP)
      await this.processTransactionUseCase.execute({
        idempotencyKey: data.idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: {
          amount: data.money.amount,
          currency: data.money.currency,
        },
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        sqsMessageId: messageIdForInbox,
        consumerName: this.consumerName,
      });

      // 2. COMMIT BEFORE ACK (Lei 10 de AGENTS.md):
      // O execute() acima comitou a transação no PostgreSQL com sucesso.
      // Agora e somente agora confirmamos o recebimento e deletamos a mensagem do SQS.
      const deleteCommand = new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      });

      await this.sqsClient.send(deleteCommand);
      this.logger.debug(
        `Successfully processed and deleted message ${messageIdForInbox} from SQS`,
      );
      return true;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error processing SQS message ${messageIdForInbox}: ${errorMsg}. Message retained in queue for redelivery.`,
      );
      // NÃO envia DeleteMessageCommand. O SQS redespachará a mensagem após o VisibilityTimeout.
      return false;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.pollOnce();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error in SqsWagerConsumerWorker loop: ${errorMsg}`);
        await this.sleep(2000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

