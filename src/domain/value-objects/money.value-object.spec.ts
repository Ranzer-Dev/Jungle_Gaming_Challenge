import { describe, expect, it } from "bun:test";
import { Money } from "./money.value-object";
import { CurrencyMismatchError, InvalidMoneyAmountError } from "../errors/money.errors";

describe("Money Value Object", () => {
  it("should create Money from valid props with scale 2", () => {
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    expect(money.toString()).toBe("25.00");
    expect(money.currency).toBe("BRL");
    expect(money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  it("should create zero Money for a given currency", () => {
    const zero = Money.zero("BRL");
    expect(zero.toString()).toBe("0.00");
    expect(zero.isZero()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(zero.isNegative()).toBe(false);
  });

  it("should perform addition immutably", () => {
    const m1 = Money.from({ amount: "25.00", currency: "BRL" });
    const m2 = Money.from({ amount: "10.50", currency: "BRL" });
    const sum = m1.add(m2);

    expect(sum.toString()).toBe("35.50");
    expect(m1.toString()).toBe("25.00"); // Imutabilidade preservada
    expect(m2.toString()).toBe("10.50");
  });

  it("should perform subtraction immutably", () => {
    const m1 = Money.from({ amount: "100.00", currency: "BRL" });
    const m2 = Money.from({ amount: "25.00", currency: "BRL" });
    const diff = m1.subtract(m2);

    expect(diff.toString()).toBe("75.00");
  });

  it("should negate amount correctly", () => {
    const m = Money.from({ amount: "50.00", currency: "BRL" });
    const negated = m.negate();

    expect(negated.toString()).toBe("-50.00");
    expect(negated.isNegative()).toBe(true);
  });

  it("should compare two Money instances correctly", () => {
    const m1 = Money.from({ amount: "20.00", currency: "BRL" });
    const m2 = Money.from({ amount: "80.00", currency: "BRL" });
    const m3 = Money.from({ amount: "20.00", currency: "BRL" });

    expect(m1.isLessThan(m2)).toBe(true);
    expect(m2.isLessThan(m1)).toBe(false);
    expect(m1.equals(m3)).toBe(true);
    expect(m1.equals(m2)).toBe(false);
  });

  it("should throw CurrencyMismatchError on operations between different currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it("should reject invalid amount formats (NaN, 1 decimal, scientific notation, empty string)", () => {
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "25.5", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "25.555", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "1e5", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "abc", currency: "BRL" })).toThrow(InvalidMoneyAmountError);
  });

  it("should reject invalid currency codes", () => {
    expect(() => Money.from({ amount: "10.00", currency: "BR" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "10.00", currency: "BRLA" })).toThrow(InvalidMoneyAmountError);
    expect(() => Money.from({ amount: "10.00", currency: "123" })).toThrow(InvalidMoneyAmountError);
  });
});

