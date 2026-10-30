import { v7 as uuidv7 } from "uuid";
import { IUnitOfWork } from "../ports/repositories.port";
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult,
} from "../dtos/wagering.dto";
import { Money } from "../../domain/value-objects/money.value-object";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/entities/wager-transaction.entity";
import { computeCanonicalPayloadHash } from "../../domain/services/canonical-hash.service";
import {
  IdempotencyPayloadMismatchError,
  InvalidReferenceKindError,
  ReferenceAlreadyRevertedError,
  ReferenceNotFoundError,
  ReferenceRoundMismatchError,
  RollbackWouldCauseNegativeBalanceError,
} from "../../domain/errors/transaction.errors";
import {
  InsufficientFundsError,
  WalletNotFoundError,
} from "../../domain/errors/wallet.errors";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wager-integration-events";
import { InboxMessage } from "../../domain/entities/inbox-message.entity";
import { LedgerDirection } from "../../domain/entities/wallet-ledger-entry.entity";

export class ProcessWagerTransactionUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const money = Money.from(command.money);
    const payloadHash = computeCanonicalPayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    return this.uow.execute(async (ctx) => {
      // 1. Transactional Inbox (Se a requisição veio via fila SQS)
      if (command.sqsMessageId && command.consumerName) {
        const existingInbox = await ctx.inbox.find(
          command.consumerName,
          command.sqsMessageId,
        );
        if (existingInbox && existingInbox.isProcessed()) {
          // Mensagem já processada anteriormente: recuperar transação existente
          const existingTx = await ctx.transactions.findByIdempotencyKey(
            command.idempotencyKey,
          );
          if (existingTx && existingTx.balanceAtProcessed) {
            return {
              transactionId: existingTx.id,
              status: existingTx.status,
              balance: existingTx.balanceAtProcessed.toJSON(),
              idempotentReplay: true,
            };
          }
        }

        const inboxMsg = InboxMessage.receive({
          messageId: command.sqsMessageId,
          consumerName: command.consumerName,
          payloadHash,
        });
        inboxMsg.markProcessed();
        ctx.inbox.persist(inboxMsg);
      }

      // 2. Verificação de Idempotência Persistente no PostgreSQL
      const existingTx = await ctx.transactions.findByIdempotencyKey(
        command.idempotencyKey,
      );
      if (existingTx) {
        if (!existingTx.matchesPayload(payloadHash)) {
          throw new IdempotencyPayloadMismatchError(command.idempotencyKey);
        }

        // Replay Idempotente idêntico com saldo histórico observado
        const historicalBalance =
          existingTx.balanceAtProcessed ??
          (await ctx.wallets.findById(command.walletId))?.balance ??
          money;

        return {
          transactionId: existingTx.id,
          status: existingTx.status,
          balance: historicalBalance.toJSON(),
          idempotentReplay: true,
        };
      }

      // 3. Lock Pessimista na Carteira (SELECT ... FOR UPDATE)
      const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(command.walletId);
      }

      if (wallet.playerId !== command.playerId) {
        throw new Error("Wallet does not belong to the requested player");
      }

      // Cria a transação em estado PENDING
      const transactionId = uuidv7();
      const transaction = WagerTransaction.create({
        id: transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: wallet.id,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

      // 4. Execução das Regras de Negócio por Tipo de Operação
      try {
        switch (command.kind) {
          case WagerTransactionKind.Bet: {
            // BET -> Débito
            const ledgerEntryId = uuidv7();
            const { newBalance, ledgerEntry } = wallet.debit(
              money,
              transaction.id,
              ledgerEntryId,
            );
            transaction.markProcessed(undefined, newBalance);

            ctx.wallets.persist(wallet);
            ctx.ledger.persist(ledgerEntry);
            ctx.transactions.persist(transaction);

            this.enqueueProcessedEvents(ctx, wallet, transaction, ledgerEntry);

            return {
              transactionId: transaction.id,
              status: transaction.status,
              balance: newBalance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Win: {
            // WIN -> Crédito
            let refTxId: string | undefined;
            if (command.referenceExternalTransactionId) {
              const refTx = await ctx.transactions.findByProviderAndExternalId(
                command.providerId,
                command.referenceExternalTransactionId,
              );
              if (refTx) {
                refTxId = refTx.id;
              }
            }

            const ledgerEntryId = uuidv7();
            const { newBalance, ledgerEntry } = wallet.credit(
              money,
              transaction.id,
              ledgerEntryId,
            );
            transaction.markProcessed(refTxId, newBalance);

            ctx.wallets.persist(wallet);
            ctx.ledger.persist(ledgerEntry);
            ctx.transactions.persist(transaction);

            this.enqueueProcessedEvents(ctx, wallet, transaction, ledgerEntry);

            return {
              transactionId: transaction.id,
              status: transaction.status,
              balance: newBalance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Loss: {
            // LOSS -> Neutro (não move saldo, não gera ledger)
            transaction.markProcessed(undefined, wallet.balance);

            ctx.transactions.persist(transaction);

            // Emite WagerTransactionProcessed para analytics
            ctx.outbox.persist(
              OutboxMessage.enqueue(
                new WagerTransactionProcessed({
                  eventId: uuidv7(),
                  aggregateId: transaction.id,
                  correlationId: command.idempotencyKey,
                  data: {
                    transactionId: transaction.id,
                    providerId: transaction.providerId,
                    externalTransactionId: transaction.externalTransactionId,
                    playerId: transaction.playerId,
                    walletId: transaction.walletId,
                    roundId: transaction.roundId,
                    gameId: transaction.gameId,
                    kind: transaction.kind,
                    money: transaction.money.toJSON(),
                    processedAt: new Date().toISOString(),
                  },
                }),
              ),
            );

            return {
              transactionId: transaction.id,
              status: transaction.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Refund: {
            // REFUND -> Estorno de BET
            const refTx = await this.resolveReference(
              ctx,
              command,
              WagerTransactionKind.Bet,
            );
            if (!refTx) {
              // Referência ausente -> PENDING_REFERENCE (README Seção 7.1)
              transaction.markPendingReference();
              ctx.transactions.persist(transaction);

              ctx.outbox.persist(
                OutboxMessage.enqueue(
                  new WagerTransactionPendingReference({
                    eventId: uuidv7(),
                    aggregateId: transaction.id,
                    correlationId: command.idempotencyKey,
                    data: {
                      transactionId: transaction.id,
                      providerId: transaction.providerId,
                      externalTransactionId: transaction.externalTransactionId,
                      referenceExternalTransactionId:
                        command.referenceExternalTransactionId!,
                      walletId: transaction.walletId,
                      playerId: transaction.playerId,
                      roundId: transaction.roundId,
                      kind: transaction.kind,
                      money: transaction.money.toJSON(),
                    },
                  }),
                ),
              );

              return {
                transactionId: transaction.id,
                status: transaction.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            // Valida se o montante é idêntico
            if (!refTx.money.equals(money)) {
              throw new Error("Refund amount must equal referenced bet amount");
            }

            const ledgerEntryId = uuidv7();
            const { newBalance, ledgerEntry } = wallet.credit(
              money,
              transaction.id,
              ledgerEntryId,
            );
            transaction.markProcessed(refTx.id, newBalance);

            ctx.wallets.persist(wallet);
            ctx.ledger.persist(ledgerEntry);
            ctx.transactions.persist(transaction);

            this.enqueueProcessedEvents(ctx, wallet, transaction, ledgerEntry);

            return {
              transactionId: transaction.id,
              status: transaction.status,
              balance: newBalance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Rollback: {
            // ROLLBACK -> Inverte BET, WIN ou REFUND
            const refTx = await this.resolveReference(ctx, command);
            if (!refTx) {
              transaction.markPendingReference();
              ctx.transactions.persist(transaction);

              ctx.outbox.persist(
                OutboxMessage.enqueue(
                  new WagerTransactionPendingReference({
                    eventId: uuidv7(),
                    aggregateId: transaction.id,
                    correlationId: command.idempotencyKey,
                    data: {
                      transactionId: transaction.id,
                      providerId: transaction.providerId,
                      externalTransactionId: transaction.externalTransactionId,
                      referenceExternalTransactionId:
                        command.referenceExternalTransactionId!,
                      walletId: transaction.walletId,
                      playerId: transaction.playerId,
                      roundId: transaction.roundId,
                      kind: transaction.kind,
                      money: transaction.money.toJSON(),
                    },
                  }),
                ),
              );

              return {
                transactionId: transaction.id,
                status: transaction.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            if (!refTx.money.equals(money)) {
              throw new Error(
                "Rollback amount must equal referenced transaction amount",
              );
            }

            const direction = transaction.ledgerDirectionFor(refTx);
            const ledgerEntryId = uuidv7();

            if (direction === LedgerDirection.Debit) {
              // Verifica se causaria saldo negativo
              if (wallet.balance.isLessThan(money)) {
                throw new RollbackWouldCauseNegativeBalanceError(
                  wallet.id,
                  wallet.balance.toString(),
                  money.toString(),
                );
              }
              const { newBalance, ledgerEntry } = wallet.debit(
                money,
                transaction.id,
                ledgerEntryId,
              );
              transaction.markProcessed(refTx.id, newBalance);

              ctx.wallets.persist(wallet);
              ctx.ledger.persist(ledgerEntry);
              ctx.transactions.persist(transaction);

              this.enqueueProcessedEvents(
                ctx,
                wallet,
                transaction,
                ledgerEntry,
              );

              return {
                transactionId: transaction.id,
                status: transaction.status,
                balance: newBalance.toJSON(),
                idempotentReplay: false,
              };
            } else {
              const { newBalance, ledgerEntry } = wallet.credit(
                money,
                transaction.id,
                ledgerEntryId,
              );
              transaction.markProcessed(refTx.id, newBalance);

              ctx.wallets.persist(wallet);
              ctx.ledger.persist(ledgerEntry);
              ctx.transactions.persist(transaction);

              this.enqueueProcessedEvents(
                ctx,
                wallet,
                transaction,
                ledgerEntry,
              );

              return {
                transactionId: transaction.id,
                status: transaction.status,
                balance: newBalance.toJSON(),
                idempotentReplay: false,
              };
            }
          }

          default:
            throw new Error(`Unsupported transaction kind: ${command.kind}`);
        }
      } catch (err: unknown) {
        // Se for erro de negócio (saldo insuficiente, estorno causaria negativo), persiste a rejeição auditável (README Seção 7)
        if (err instanceof InsufficientFundsError) {
          transaction.reject("INSUFFICIENT_FUNDS", wallet.balance);
          ctx.transactions.persist(transaction);

          this.enqueueRejectedEvent(
            ctx,
            transaction,
            "INSUFFICIENT_FUNDS",
            err.message,
          );
          throw err;
        }

        if (err instanceof RollbackWouldCauseNegativeBalanceError) {
          transaction.reject(
            "ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE",
            wallet.balance,
          );
          ctx.transactions.persist(transaction);

          this.enqueueRejectedEvent(
            ctx,
            transaction,
            "ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE",
            err.message,
          );
          throw err;
        }

        if (err instanceof ReferenceAlreadyRevertedError) {
          transaction.reject("REFERENCE_ALREADY_REVERTED", wallet.balance);
          ctx.transactions.persist(transaction);

          this.enqueueRejectedEvent(
            ctx,
            transaction,
            "REFERENCE_ALREADY_REVERTED",
            err.message,
          );
          throw err;
        }

        throw err;
      }
    });
  }

  private async resolveReference(
    ctx: any,
    command: ProcessWagerTransactionCommand,
    expectedKind?: WagerTransactionKind,
  ): Promise<WagerTransaction | null> {
    if (!command.referenceExternalTransactionId) {
      throw new ReferenceNotFoundError("undefined");
    }

    const refTx = await ctx.transactions.findByProviderAndExternalId(
      command.providerId,
      command.referenceExternalTransactionId,
    );

    if (!refTx) {
      return null;
    }

    // Validação estrita das 5 invariantes cruzadas (README Seção 7 e ADR-004)
    if (refTx.roundId !== command.roundId) {
      throw new ReferenceRoundMismatchError(refTx.roundId, command.roundId);
    }

    if (refTx.playerId !== command.playerId || refTx.walletId !== command.walletId) {
      throw new Error("Reference player or wallet mismatch");
    }

    if (expectedKind && refTx.kind !== expectedKind) {
      throw new InvalidReferenceKindError(expectedKind, refTx.kind);
    }

    return refTx;
  }

  private enqueueProcessedEvents(
    ctx: any,
    wallet: any,
    tx: WagerTransaction,
    ledgerEntry: any,
  ): void {
    // 1. WalletBalanceChanged
    ctx.outbox.persist(
      OutboxMessage.enqueue(
        new WalletBalanceChanged({
          eventId: uuidv7(),
          aggregateId: wallet.id,
          correlationId: tx.idempotencyKey,
          data: {
            walletId: wallet.id,
            playerId: wallet.playerId,
            transactionId: tx.id,
            direction: ledgerEntry.direction,
            money: ledgerEntry.money.toJSON(),
            balanceBefore: ledgerEntry.balanceBefore.toJSON(),
            balanceAfter: ledgerEntry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        }),
      ),
    );

    // 2. WagerTransactionProcessed
    ctx.outbox.persist(
      OutboxMessage.enqueue(
        new WagerTransactionProcessed({
          eventId: uuidv7(),
          aggregateId: tx.id,
          correlationId: tx.idempotencyKey,
          data: {
            transactionId: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: tx.money.toJSON(),
            referenceExternalTransactionId: tx.referenceExternalTransactionId,
            processedAt: tx.processedAt?.toISOString() ?? new Date().toISOString(),
          },
        }),
      ),
    );
  }

  private enqueueRejectedEvent(
    ctx: any,
    tx: WagerTransaction,
    failureCode: any,
    reason: string,
  ): void {
    ctx.outbox.persist(
      OutboxMessage.enqueue(
        new WagerTransactionRejected({
          eventId: uuidv7(),
          aggregateId: tx.id,
          correlationId: tx.idempotencyKey,
          data: {
            transactionId: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            playerId: tx.playerId,
            walletId: tx.walletId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            money: tx.money.toJSON(),
            failureCode,
            reason,
          },
        }),
      ),
    );
  }
}

