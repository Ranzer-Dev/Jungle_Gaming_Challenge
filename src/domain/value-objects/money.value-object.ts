import { Decimal } from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyAmountError } from "../errors/money.errors";

export interface MoneyProps {
  amount: string;   // decimal string, ex: "25.00"
  currency: string; // ISO-4217, ex: "BRL"
}

export class Money {
  private static readonly DECIMAL_REGEX = /^-?\d+\.\d{2}$/;
  private static readonly CURRENCY_REGEX = /^[A-Z]{3}$/;

  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  public static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyAmountError("Money props must include valid amount and currency strings");
    }

    const trimmedCurrency = props.currency.trim().toUpperCase();
    if (!Money.CURRENCY_REGEX.test(trimmedCurrency)) {
      throw new InvalidMoneyAmountError(`Invalid currency code: '${props.currency}'. Expected 3-letter ISO-4217 code`);
    }

    const trimmedAmount = props.amount.trim();
    if (!Money.DECIMAL_REGEX.test(trimmedAmount)) {
      throw new InvalidMoneyAmountError(
        `Invalid amount format: '${props.amount}'. Amount must be a decimal string with exactly 2 decimal places (e.g. '25.00')`,
      );
    }

    let decimalVal: Decimal;
    try {
      decimalVal = new Decimal(trimmedAmount);
    } catch {
      throw new InvalidMoneyAmountError(`Could not parse amount: '${props.amount}'`);
    }

    if (!decimalVal.isFinite()) {
      throw new InvalidMoneyAmountError("Amount cannot be NaN or Infinity");
    }

    return new Money(decimalVal, trimmedCurrency);
  }

  public static zero(currency: string): Money {
    const trimmedCurrency = currency.trim().toUpperCase();
    if (!Money.CURRENCY_REGEX.test(trimmedCurrency)) {
      throw new InvalidMoneyAmountError(`Invalid currency code: '${currency}'. Expected 3-letter ISO-4217 code`);
    }
    return new Money(new Decimal("0.00"), trimmedCurrency);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.toString(),
      currency: this.currency,
    };
  }

  public toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

