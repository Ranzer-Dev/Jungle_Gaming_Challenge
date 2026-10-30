import { describe, expect, it } from "bun:test";
import { Money } from "../value-objects/money.value-object";
import { Wallet } from "./wallet.aggregate";
import { LedgerDirection } from "./wallet-ledger-entry.entity";
import { InsufficientFundsError } from "../errors/wallet.errors";

describe("Wallet Aggregate Root & Ledger Entry", () => {
  it("should open wallet with version 1 and positive balance", () => {
    const initial = Money.from({ amount: "100.00", currency: "BRL" });
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: initial,
    });

    expect(wallet.id).toBe("w-1");
    expect(wallet.playerId).toBe("p-1");
    expect(wallet.currency).toBe("BRL");
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  it("should debit wallet correctly and produce balanced ledger entry", () => {
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const debitAmount = Money.from({ amount: "30.00", currency: "BRL" });
    const { newBalance, ledgerEntry } = wallet.debit(debitAmount, "tx-1", "led-1");

    expect(newBalance.toString()).toBe("70.00");
    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2); // Incrementa version

    expect(ledgerEntry.direction).toBe(LedgerDirection.Debit);
    expect(ledgerEntry.balanceBefore.toString()).toBe("100.00");
    expect(ledgerEntry.money.toString()).toBe("30.00");
    expect(ledgerEntry.balanceAfter.toString()).toBe("70.00");
    expect(ledgerEntry.isBalanced()).toBe(true);
  });

  it("should throw InsufficientFundsError when debit exceeds balance", () => {
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    const debitAmount = Money.from({ amount: "80.00", currency: "BRL" });

    expect(() => wallet.debit(debitAmount, "tx-1", "led-1")).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("50.00");
    expect(wallet.version).toBe(1); // Não incrementa version se falhar
  });

  it("should credit wallet correctly and increment version", () => {
    const wallet = Wallet.open({
      id: "w-1",
      playerId: "p-1",
      initialBalance: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    const creditAmount = Money.from({ amount: "25.00", currency: "BRL" });
    const { newBalance, ledgerEntry } = wallet.credit(creditAmount, "tx-2", "led-2");

    expect(newBalance.toString()).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(ledgerEntry.direction).toBe(LedgerDirection.Credit);
    expect(ledgerEntry.isBalanced()).toBe(true);
  });
});

