import { InsufficientFundsError } from "../errors/wallet.errors";
import { Money } from "../value-objects/money.value-object";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "./wallet-ledger-entry.entity";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface RehydrateWalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  public balance: Money;
  public version: number;
  public updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    balance: Money,
    version: number,
    public readonly createdAt: Date,
    updatedAt: Date,
  ) {
    this.balance = balance;
    this.version = version;
    this.updatedAt = updatedAt;
  }

  public static open(props: OpenWalletProps): Wallet {
    if (!props.id || !props.playerId) {
      throw new Error("Wallet requires valid id and playerId");
    }

    if (props.initialBalance.isNegative()) {
      throw new Error("Wallet cannot be opened with negative balance");
    }

    const now = props.createdAt ?? new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // version inicia em 1 após criação
      now,
      now,
    );
  }

  public static rehydrate(state: RehydrateWalletProps): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  public debit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    at: Date = new Date(),
  ): { newBalance: Money; ledgerEntry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);

    if (amount.isNegative() || amount.isZero()) {
      throw new Error("Debit amount must be strictly positive");
    }

    if (this.balance.isLessThan(amount)) {
      throw new InsufficientFundsError(this.id, this.balance.toString(), amount.toString());
    }

    const balanceBefore = this.balance;
    const balanceAfter = this.balance.subtract(amount);

    const ledgerEntry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    this.balance = balanceAfter;
    this.version += 1; // Incrementa somente quando o saldo muda (README L209)
    this.updatedAt = at;

    return { newBalance: this.balance, ledgerEntry };
  }

  public credit(
    amount: Money,
    transactionId: string,
    ledgerEntryId: string,
    at: Date = new Date(),
  ): { newBalance: Money; ledgerEntry: WalletLedgerEntry } {
    this.assertSameCurrency(amount);

    if (amount.isNegative() || amount.isZero()) {
      throw new Error("Credit amount must be strictly positive");
    }

    const balanceBefore = this.balance;
    const balanceAfter = this.balance.add(amount);

    const ledgerEntry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money: amount,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    });

    this.balance = balanceAfter;
    this.version += 1; // Incrementa somente quando o saldo muda (README L209)
    this.updatedAt = at;

    return { newBalance: this.balance, ledgerEntry };
  }

  public canDebit(amount: Money): boolean {
    this.assertSameCurrency(amount);
    return !this.balance.isLessThan(amount);
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error(
        `Wallet currency '${this.currency}' does not match operation currency '${money.currency}'`,
      );
    }
  }
}
