import { Money } from "../value-objects/money.value-object";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.entity";
import { InsufficientFundsError } from "../errors/wallet.errors";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

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

  public static rehydrate(state: WalletState): Wallet {
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

  public get balance(): Money {
    return this._balance;
  }

  public get version(): number {
    return this._version;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
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

    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError(this.id, this._balance.toString(), amount.toString());
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(amount);

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

    this._balance = balanceAfter;
    this._version += 1; // Incrementa somente quando o saldo muda (README L209)
    this._updatedAt = at;

    return { newBalance: this._balance, ledgerEntry };
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

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(amount);

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

    this._balance = balanceAfter;
    this._version += 1; // Incrementa somente quando o saldo muda
    this._updatedAt = at;

    return { newBalance: this._balance, ledgerEntry };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error(`Currency mismatch: wallet has '${this.currency}' but operation requested '${money.currency}'`);
    }
  }
}

