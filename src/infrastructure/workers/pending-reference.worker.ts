import { Logger } from "@nestjs/common";
import { IUnitOfWork, IUnitOfWorkContext } from "../../application/ports/repositories.port";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/entities/wallet-ledger-entry.entity";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction.entity";
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/wager-integration-events";

export interface PendingReferenceWorkerConfig {
  pollIntervalMs?: number;
  maxAgeMs?: number; // Tempo máximo de espera antes de rejeitar com REFERENCE_NOT_FOUND (default 60s)
  batchSize?: number;
}

export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private isRunning = false;
  private loopPromise?: Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxAgeMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly unitOfWork: IUnitOfWork,
    config?: PendingReferenceWorkerConfig,
  ) {
    this.pollIntervalMs = config?.pollIntervalMs ?? 3000;
    this.maxAgeMs = config?.maxAgeMs ?? 60000; // 60s
    this.batchSize = config?.batchSize ?? 20;
  }

  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger.log(
      `Starting PendingReferenceWorker (pollInterval: ${this.pollIntervalMs}ms, maxAge: ${this.maxAgeMs}ms)`,
    );
    this.loopPromise = this.runLoop();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.logger.log("Stopping PendingReferenceWorker gracefully...");
    this.isRunning = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.log("PendingReferenceWorker stopped.");
  }

  public async evaluatePendingReferences(): Promise<number> {
    return this.unitOfWork.execute(async (ctx: IUnitOfWorkContext) => {
      const pendingList = await ctx.transactions.findPendingReferences(this.batchSize);
      if (pendingList.length === 0) {
        return 0;
      }

      this.logger.debug(
        `Evaluating ${pendingList.length} transactions in PENDING_REFERENCE state`,
      );

      const now = new Date();

      for (const tx of pendingList) {
        await this.processSinglePendingReference(tx, now, ctx);
      }

      return pendingList.length;
    });
  }

  private async processSinglePendingReference(
    tx: WagerTransaction,
    now: Date,
    ctx: IUnitOfWorkContext,
  ): Promise<void> {
    const { transactions, wallets, ledger, outbox } = ctx;

    // 1. Localiza a transação pai referenciada
    let parentTx: WagerTransaction | null = null;
    if (tx.referenceTransactionId) {
      parentTx = await transactions.findById(tx.referenceTransactionId);
    } else if (tx.referenceExternalTransactionId) {
      parentTx = await transactions.findByProviderAndExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId,
      );
    }

    // 2. Se a transação pai ainda não chegou
    if (!parentTx || parentTx.status !== WagerTransactionStatus.Processed) {
      const ageMs = now.getTime() - tx.createdAt.getTime();
      if (ageMs > this.maxAgeMs) {
        // Expirou o tempo de espera: transiciona para REJECTED por REFERENCE_NOT_FOUND
        this.logger.warn(
          `Transaction ${tx.id} exceeded max age (${ageMs}ms > ${this.maxAgeMs}ms). Rejecting as REFERENCE_NOT_FOUND.`,
        );
        tx.reject("REFERENCE_NOT_FOUND");
        transactions.persist(tx);

        const rejectedEvent = new WagerTransactionRejected({
          aggregateId: tx.walletId,
          data: {
            transactionId: tx.id,
            walletId: tx.walletId,
            playerId: tx.playerId,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: tx.money.toProps(),
            failureCode: "REFERENCE_NOT_FOUND",
            reason: "Referenced parent transaction was not found within timeout window",
          },
        });
        outbox.persist(OutboxMessage.enqueue(rejectedEvent));
      }
      return;
    }

    // 3. Pai encontrado e PROCESSED! Validar invariantes
    if (parentTx.roundId !== tx.roundId) {
      tx.reject("REFERENCE_ROUND_MISMATCH");
      transactions.persist(tx);
      const rejectedEvent = new WagerTransactionRejected({
        aggregateId: tx.walletId,
        data: {
          transactionId: tx.id,
          walletId: tx.walletId,
          playerId: tx.playerId,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          money: tx.money.toProps(),
          failureCode: "REFERENCE_ROUND_MISMATCH",
          reason: "Reference transaction belongs to different round",
        },
      });
      outbox.persist(OutboxMessage.enqueue(rejectedEvent));
      return;
    }

    // Lock na carteira para efetivar a transação com segurança
    const wallet = await wallets.findByIdForUpdate(tx.walletId);
    if (!wallet) {
      tx.reject("WALLET_NOT_FOUND");
      transactions.persist(tx);
      return;
    }

    // Executa a operação de acordo com o kind
    if (tx.kind === WagerTransactionKind.Refund) {
      const balanceBefore = wallet.balance;
      const ledgerEntryId = crypto.randomUUID();
      const { ledgerEntry } = wallet.credit(tx.money, tx.id, ledgerEntryId, now);
      wallets.persist(wallet);
      ledger.persist(ledgerEntry);

      tx.markProcessed(parentTx.id, wallet.balance);
      transactions.persist(tx);

      const balanceChangedEvent = new WalletBalanceChanged({
        aggregateId: wallet.id,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          transactionId: tx.id,
          direction: LedgerDirection.Credit,
          money: tx.money.toProps(),
          balanceBefore: balanceBefore.toProps(),
          balanceAfter: wallet.balance.toProps(),
          walletVersion: wallet.version,
        },
      });

      const processedEvent = new WagerTransactionProcessed({
        aggregateId: wallet.id,
        data: {
          transactionId: tx.id,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          money: tx.money.toProps(),
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          processedAt: new Date().toISOString(),
        },
      });

      outbox.persist(OutboxMessage.enqueue(balanceChangedEvent));
      outbox.persist(OutboxMessage.enqueue(processedEvent));
      return;
    }

    if (tx.kind === WagerTransactionKind.Rollback) {
      const inverseDirection = tx.determineRollbackDirection(parentTx);
      const balanceBefore = wallet.balance;
      const ledgerEntryId = crypto.randomUUID();

      let ledgerEntry: WalletLedgerEntry;
      if (inverseDirection === LedgerDirection.Credit) {
        const result = wallet.credit(tx.money, tx.id, ledgerEntryId, now);
        ledgerEntry = result.ledgerEntry;
      } else {
        if (!wallet.canDebit(tx.money)) {
          tx.reject("ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE");
          transactions.persist(tx);
          const rejectedEvent = new WagerTransactionRejected({
            aggregateId: tx.walletId,
            data: {
              transactionId: tx.id,
              walletId: tx.walletId,
              playerId: tx.playerId,
              providerId: tx.providerId,
              externalTransactionId: tx.externalTransactionId,
              roundId: tx.roundId,
              gameId: tx.gameId,
              kind: tx.kind,
              money: tx.money.toProps(),
              failureCode: "ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE",
              reason: "Rollback debit would result in negative balance",
            },
          });
          outbox.persist(OutboxMessage.enqueue(rejectedEvent));
          return;
        }
        const result = wallet.debit(tx.money, tx.id, ledgerEntryId, now);
        ledgerEntry = result.ledgerEntry;
      }

      wallets.persist(wallet);
      ledger.persist(ledgerEntry);

      tx.markProcessed(parentTx.id, wallet.balance);
      transactions.persist(tx);

      const balanceChangedEvent = new WalletBalanceChanged({
        aggregateId: wallet.id,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          transactionId: tx.id,
          direction: inverseDirection,
          money: tx.money.toProps(),
          balanceBefore: balanceBefore.toProps(),
          balanceAfter: wallet.balance.toProps(),
          walletVersion: wallet.version,
        },
      });

      const processedEvent = new WagerTransactionProcessed({
        aggregateId: wallet.id,
        data: {
          transactionId: tx.id,
          providerId: tx.providerId,
          externalTransactionId: tx.externalTransactionId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: tx.roundId,
          gameId: tx.gameId,
          kind: tx.kind,
          money: tx.money.toProps(),
          referenceExternalTransactionId: tx.referenceExternalTransactionId,
          processedAt: new Date().toISOString(),
        },
      });

      outbox.persist(OutboxMessage.enqueue(balanceChangedEvent));
      outbox.persist(OutboxMessage.enqueue(processedEvent));
    }
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.evaluatePendingReferences();
        await this.sleep(this.pollIntervalMs);
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error in PendingReferenceWorker loop: ${errorMsg}`);
        await this.sleep(this.pollIntervalMs * 2);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
