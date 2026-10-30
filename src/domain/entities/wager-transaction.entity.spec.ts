import { describe, expect, it } from "bun:test";
import { Money } from "../value-objects/money.value-object";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction.entity";
import { InvalidTransactionStateError } from "../errors/transaction.errors";
import { LedgerDirection } from "./wallet-ledger-entry.entity";

describe("WagerTransaction Entity", () => {
  const baseMoney = Money.from({ amount: "25.00", currency: "BRL" });

  it("should create a valid BET transaction in PENDING state", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash-123",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: baseMoney,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.affectsBalance()).toBe(true);
    expect(tx.requiresReference()).toBe(false);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it("should require referenceExternalTransactionId for REFUND and ROLLBACK", () => {
    expect(() =>
      WagerTransaction.create({
        id: "tx-2",
        providerId: "provider-a",
        externalTransactionId: "ext-2",
        idempotencyKey: "provider-a:ext-2",
        payloadHash: "hash-456",
        walletId: "w-1",
        playerId: "p-1",
        roundId: "r-1",
        gameId: "g-1",
        kind: WagerTransactionKind.Refund,
        money: baseMoney,
      }),
    ).toThrow("REFUND requires a valid referenceExternalTransactionId");
  });

  it("should transition from PENDING to PROCESSED and record processed balance", () => {
    const tx = WagerTransaction.create({
      id: "tx-3",
      providerId: "provider-a",
      externalTransactionId: "ext-3",
      idempotencyKey: "provider-a:ext-3",
      payloadHash: "hash-789",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: baseMoney,
    });

    const balanceAfter = Money.from({ amount: "75.00", currency: "BRL" });
    tx.markProcessed(undefined, balanceAfter);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.balanceAtProcessed?.toString()).toBe("75.00");
  });

  it("should throw InvalidTransactionStateError when transitioning from terminal state", () => {
    const tx = WagerTransaction.create({
      id: "tx-4",
      providerId: "provider-a",
      externalTransactionId: "ext-4",
      idempotencyKey: "provider-a:ext-4",
      payloadHash: "hash-000",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: baseMoney,
    });

    tx.reject("INSUFFICIENT_FUNDS");
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.isTerminal()).toBe(true);

    expect(() => tx.markProcessed(undefined, baseMoney)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("should determine inverse ledger direction for ROLLBACK", () => {
    const betTx = WagerTransaction.create({
      id: "tx-bet",
      providerId: "provider-a",
      externalTransactionId: "ext-bet",
      idempotencyKey: "key-bet",
      payloadHash: "h1",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Bet,
      money: baseMoney,
    });

    const rollbackBet = WagerTransaction.create({
      id: "tx-rb-bet",
      providerId: "provider-a",
      externalTransactionId: "ext-rb-1",
      idempotencyKey: "key-rb-1",
      payloadHash: "h2",
      walletId: "w-1",
      playerId: "p-1",
      roundId: "r-1",
      gameId: "g-1",
      kind: WagerTransactionKind.Rollback,
      money: baseMoney,
      referenceExternalTransactionId: "ext-bet",
    });

    // Reversão de BET (Débito) deve ser CREDIT
    expect(rollbackBet.ledgerDirectionFor(betTx)).toBe(LedgerDirection.Credit);
  });
});

