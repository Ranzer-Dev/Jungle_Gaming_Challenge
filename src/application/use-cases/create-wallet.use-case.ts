import { v7 as uuidv7 } from "uuid";
import { IUnitOfWork } from "../ports/repositories.port";
import { CreateWalletCommand, WalletDto } from "../dtos/wagering.dto";
import { Money } from "../../domain/value-objects/money.value-object";
import { Wallet } from "../../domain/entities/wallet.aggregate";
import { WagerTransaction, WagerTransactionKind } from "../../domain/entities/wager-transaction.entity";
import { WalletAlreadyExistsError } from "../../domain/errors/wallet.errors";
import { OutboxMessage } from "../../domain/entities/outbox-message.entity";
import { WalletBalanceChanged } from "../../domain/events/wager-integration-events";

export class CreateWalletUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(command: CreateWalletCommand): Promise<WalletDto> {
    const initialMoney = Money.from(command.initialBalance);

    return this.uow.execute(async (ctx) => {
      // 1. Valida se já existe carteira para o jogador e moeda
      const existing = await ctx.wallets.findByPlayerAndCurrency(
        command.playerId,
        initialMoney.currency,
      );

      if (existing) {
        throw new WalletAlreadyExistsError(command.playerId, initialMoney.currency);
      }

      const walletId = uuidv7();

      // 2. Se initialBalance for 0, abre a carteira com saldo zero
      if (initialMoney.isZero()) {
        const wallet = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance: initialMoney,
        });

        ctx.wallets.persist(wallet);

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      }

      // 3. Se initialBalance > 0, cria carteira com 0 e aplica crédito atômico OPENING (README Linhas 449-450)
      const wallet = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: Money.zero(initialMoney.currency),
      });

      const openingTransactionId = uuidv7();
      const ledgerEntryId = uuidv7();
      const openingTx = WagerTransaction.create({
        id: openingTransactionId,
        providerId: "INTERNAL",
        externalTransactionId: `OPENING-${walletId}`,
        idempotencyKey: `INTERNAL:OPENING:${walletId}`,
        payloadHash: "INTERNAL_OPENING",
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "OPENING_ROUND",
        gameId: "SYSTEM",
        kind: WagerTransactionKind.Opening,
        money: initialMoney,
      });

      const { newBalance, ledgerEntry } = wallet.credit(
        initialMoney,
        openingTransactionId,
        ledgerEntryId,
      );

      openingTx.markProcessed(undefined, newBalance);

      // Persiste carteira, transação e ledger na mesma transação SQL
      ctx.wallets.persist(wallet);
      ctx.transactions.persist(openingTx);
      ctx.ledger.persist(ledgerEntry);

      // Enfileira evento WalletBalanceChanged na Outbox
      const balanceEvent = new WalletBalanceChanged({
        eventId: uuidv7(),
        aggregateId: wallet.id,
        correlationId: `open-${wallet.id}`,
        data: {
          walletId: wallet.id,
          playerId: wallet.playerId,
          transactionId: openingTransactionId,
          direction: ledgerEntry.direction,
          money: initialMoney.toJSON(),
          balanceBefore: Money.zero(initialMoney.currency).toJSON(),
          balanceAfter: newBalance.toJSON(),
          walletVersion: wallet.version,
        },
      });

      ctx.outbox.persist(OutboxMessage.enqueue(balanceEvent));

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
