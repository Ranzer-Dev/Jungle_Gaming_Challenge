import { IUnitOfWork } from "../ports/repositories.port";
import { WalletReconciliationResult } from "../dtos/wagering.dto";
import { WalletNotFoundError } from "../../domain/errors/wallet.errors";
import { Money } from "../../domain/value-objects/money.value-object";
import { Decimal } from "decimal.js";

export class ReconcileWalletUseCase {
  constructor(private readonly uow: IUnitOfWork) {}

  public async execute(walletId: string): Promise<WalletReconciliationResult> {
    return this.uow.execute(async (ctx) => {
      const wallet = await ctx.wallets.findById(walletId);
      if (!wallet) {
        throw new WalletNotFoundError(walletId);
      }

      // Soma créditos e débitos do ledger (Seção 9 e 13 do README)
      const { totalCredits, totalDebits, count } =
        await ctx.ledger.sumCreditsAndDebits(walletId);

      const credits = new Decimal(totalCredits);
      const debits = new Decimal(totalDebits);
      const calculatedDecimal = credits.minus(debits);

      const storedMoney = wallet.balance;
      const calculatedMoney = Money.from({
        amount: calculatedDecimal.toFixed(2),
        currency: storedMoney.currency,
      });

      const differenceDecimal = new Decimal(storedMoney.toString()).minus(
        calculatedDecimal,
      );
      const differenceMoney = Money.from({
        amount: differenceDecimal.abs().toFixed(2),
        currency: storedMoney.currency,
      });

      const consistent = differenceDecimal.isZero();

      return {
        walletId: wallet.id,
        storedBalance: storedMoney.toJSON(),
        calculatedBalance: calculatedMoney.toJSON(),
        difference: differenceMoney.toJSON(),
        consistent,
        checkedEntries: count,
      };
    });
  }
}
