import { DomainError } from "./domain.error";

export class InvalidTransactionStateError extends DomainError {
  public readonly failureCode = "INVALID_TRANSACTION_STATE";
  public readonly statusCode = 422;

  constructor(fromStatus: string, action: string) {
    super(`Cannot execute '${action}' on transaction in terminal state '${fromStatus}'`);
  }
}

export class IdempotencyPayloadMismatchError extends DomainError {
  public readonly failureCode = "IDEMPOTENCY_PAYLOAD_MISMATCH";
  public readonly statusCode = 409;

  constructor(idempotencyKey: string) {
    super(`Idempotency key '${idempotencyKey}' was reused with conflicting payload hash`);
  }
}

export class ReferenceNotFoundError extends DomainError {
  public readonly failureCode = "REFERENCE_NOT_FOUND";
  public readonly statusCode = 422;

  constructor(referenceExternalId: string) {
    super(`Referenced external transaction '${referenceExternalId}' was not found`);
  }
}

export class ReferenceAlreadyRevertedError extends DomainError {
  public readonly failureCode = "REFERENCE_ALREADY_REVERTED";
  public readonly statusCode = 422;

  constructor(referenceExternalId: string) {
    super(`Referenced transaction '${referenceExternalId}' has already been reverted`);
  }
}

export class InvalidReferenceKindError extends DomainError {
  public readonly failureCode = "INVALID_REFERENCE_KIND";
  public readonly statusCode = 422;

  constructor(expectedKind: string, receivedKind: string) {
    super(`Invalid reference kind: expected '${expectedKind}', but found '${receivedKind}'`);
  }
}

export class ReferenceRoundMismatchError extends DomainError {
  public readonly failureCode = "REFERENCE_ROUND_MISMATCH";
  public readonly statusCode = 422;

  constructor(expectedRound: string, receivedRound: string) {
    super(`Reference round mismatch: expected '${expectedRound}', but found '${receivedRound}'`);
  }
}

export class RollbackWouldCauseNegativeBalanceError extends DomainError {
  public readonly failureCode = "ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE";
  public readonly statusCode = 422;

  constructor(walletId: string, balance: string, rollbackAmount: string) {
    super(
      `Rollback rejected: deducting ${rollbackAmount} would result in negative balance for wallet '${walletId}' (current balance: ${balance})`,
    );
  }
}

export class ProviderIdentityMismatchError extends DomainError {
  public readonly failureCode = "PROVIDER_IDENTITY_MISMATCH";
  public readonly statusCode = 403;

  constructor(claimedProvider: string, authenticatedProvider: string) {
    super(
      `Provider identity mismatch: request claims to be '${claimedProvider}', but credentials belong to '${authenticatedProvider}'`,
    );
  }
}


