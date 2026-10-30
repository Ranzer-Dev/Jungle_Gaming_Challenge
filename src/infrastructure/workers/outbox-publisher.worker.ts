import { Logger } from "@nestjs/common";
import { IMessageQueuePublisher } from "../../application/ports/message-queue-publisher.port";
import { IUnitOfWork } from "../../application/ports/repositories.port";

export interface OutboxWorkerConfig {
  batchSize?: number;
  pollIntervalMs?: number;
}

export class OutboxPublisherWorker {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private isRunning = false;
  private loopPromise?: Promise<void>;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly unitOfWork: IUnitOfWork,
    private readonly publisher: IMessageQueuePublisher,
    config?: OutboxWorkerConfig,
  ) {
    this.batchSize = config?.batchSize ?? 50;
    this.pollIntervalMs = config?.pollIntervalMs ?? 500;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger.log(
      `Starting OutboxPublisherWorker (batchSize: ${this.batchSize}, pollInterval: ${this.pollIntervalMs}ms)`,
    );
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.logger.log("Stopping OutboxPublisherWorker gracefully...");
    this.isRunning = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.log("OutboxPublisherWorker stopped.");
  }

  public async processBatch(): Promise<number> {
    return this.unitOfWork.execute(async ({ outbox }) => {
      const messages = await outbox.fetchUnpublished(this.batchSize);
      if (messages.length === 0) {
        return 0;
      }

      this.logger.debug(`Found ${messages.length} unpublished outbox messages to publish`);

      const { successfulIds, failedIds } = await this.publisher.publishBatch(messages);

      const successSet = new Set(successfulIds);
      const failedSet = new Set(failedIds);

      for (const msg of messages) {
        if (successSet.has(msg.id)) {
          msg.markPublished();
        } else if (failedSet.has(msg.id)) {
          msg.scheduleRetry();
        }
      }

      this.logger.debug(
        `Batch processed: ${successfulIds.length} published, ${failedIds.length} retried`,
      );
      return messages.length;
    });
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();

        // Se processou mensagens cheias no lote, continua imediatamente para drenar fila
        if (processedCount < this.batchSize) {
          await this.sleep(this.pollIntervalMs);
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error in outbox publisher loop: ${errorMsg}`);
        await this.sleep(this.pollIntervalMs * 2);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
