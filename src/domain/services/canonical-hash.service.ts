import { createHash } from "node:crypto";

export interface CanonicalPayloadInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string | null;
}

export function computeCanonicalPayloadHash(input: CanonicalPayloadInput): string {
  // Ordenação lexicográfica estrita dos 10 campos de negócio (RFC 8785)
  const canonicalObject = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    roundId: input.roundId,
    walletId: input.walletId,
  };

  const canonicalJson = JSON.stringify(canonicalObject);
  return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}

