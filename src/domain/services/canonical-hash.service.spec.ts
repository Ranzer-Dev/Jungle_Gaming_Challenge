import { describe, expect, it } from "bun:test";
import { computeCanonicalPayloadHash } from "./canonical-hash.service";

describe("Canonical Hash Service", () => {
  it("should generate deterministic SHA-256 regardless of property declaration order", () => {
    const inputA = {
      providerId: "pragmatic",
      externalTransactionId: "tx-123",
      playerId: "player-999",
      walletId: "wallet-888",
      roundId: "round-777",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: null,
    };

    const inputB = {
      roundId: "round-777",
      money: { currency: "BRL", amount: "25.00" },
      gameId: "fortune-chimp",
      walletId: "wallet-888",
      externalTransactionId: "tx-123",
      kind: "BET",
      playerId: "player-999",
      providerId: "pragmatic",
      referenceExternalTransactionId: null,
    };

    const hashA = computeCanonicalPayloadHash(inputA);
    const hashB = computeCanonicalPayloadHash(inputB);

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64); // SHA-256 hex string
  });

  it("should generate different hashes when business fields differ", () => {
    const base = {
      providerId: "pragmatic",
      externalTransactionId: "tx-123",
      playerId: "player-999",
      walletId: "wallet-888",
      roundId: "round-777",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    const alteredAmount = {
      ...base,
      money: { amount: "25.01", currency: "BRL" },
    };

    const alteredPlayer = {
      ...base,
      playerId: "player-000",
    };

    const hashBase = computeCanonicalPayloadHash(base);
    const hashAlteredAmount = computeCanonicalPayloadHash(alteredAmount);
    const hashAlteredPlayer = computeCanonicalPayloadHash(alteredPlayer);

    expect(hashBase).not.toBe(hashAlteredAmount);
    expect(hashBase).not.toBe(hashAlteredPlayer);
  });
});

