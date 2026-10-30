import { Money } from "../value-objects/money.value-object";
import { LedgerDirection } from "./wallet-ledger-entry.entity";
import { InvalidTransactionStateError } from "../errors/transaction.errors";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export type FailureCode =
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "WALLET_NOT_FOUND"
  | "WALLET_ALREADY_EXISTS"
  | "CURRENCY_MISMATCH"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_ALREADY_REVERTED"
  | "INVALID_REFERENCE_KIND"
  | "REFERENCE_ROUND_MISMATCH"
  | "ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE"
  | "INVALID_MONEY_AMOUNT"
  | "INVALID_TRANSACTION_STATE"
  | "PROVIDER_IDENTITY_MISMATCH";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAtProcessed?: Money;
  processedAt?: Date;
}

export class WagerTransaction {
  public status: WagerTransactionStatus;
  public referenceTransactionId?: string;
  public failureCode?: FailureCode;
  public balanceAtProcessed?: Money;
  public processedAt?: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    balanceAtProcessed?: Money,
    processedAt?: Date,
  ) {
    this.status = status;
    this.referenceTransactionId = referenceTransactionId;
    this.failureCode = failureCode;
    this.balanceAtProcessed = balanceAtProcessed;
    this.processedAt = processedAt;
  }

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.walletId) {
      throw new Error("Missing required transaction identifiers");
    }

    if (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) {
      if (!props.referenceExternalTransactionId) {
        throw new Error(`${props.kind} requires a valid referenceExternalTransactionId`);
      }
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.balanceAtProcessed,
      state.processedAt,
    );
  }

  public markProcessed(
    referenceTransactionId: string | undefined,
    balanceAtProcessed: Money,
    at: Date = new Date(),
  ): void {
    this.assertNotTerminal("markProcessed");
    this.status = WagerTransactionStatus.Processed;
    this.referenceTransactionId = referenceTransactionId;
    this.balanceAtProcessed = balanceAtProcessed;
    this.processedAt = at;
  }

  public markPendingReference(): void {
    this.assertNotTerminal("markPendingReference");
    this.status = WagerTransactionStatus.PendingReference;
  }

  public reject(code: FailureCode, balanceAtProcessed?: Money, at: Date = new Date()): void {
    this.assertNotTerminal("reject");
    this.status = WagerTransactionStatus.Rejected;
    this.failureCode = code;
    this.balanceAtProcessed = balanceAtProcessed;
    this.processedAt = at;
  }

  public fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal("fail");
    this.status = WagerTransactionStatus.Failed;
    this.failureCode = code;
    this.processedAt = at;
  }

  public isTerminal(): boolean {
    return (
      this.status === WagerTransactionStatus.Processed ||
      this.status === WagerTransactionStatus.Rejected ||
      this.status === WagerTransactionStatus.Failed
    );
  }

  public isReversible(): boolean {
    return (
      this.status === WagerTransactionStatus.Processed &&
      (this.kind === WagerTransactionKind.Bet || this.kind === WagerTransactionKind.Win)
    );
  }

  public linkReference(referenceId: string): void {
    this.referenceTransactionId = referenceId;
  }

  public affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  public requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  public determineRollbackDirection(parentTransaction: WagerTransaction): LedgerDirection {
    if (parentTransaction.kind === WagerTransactionKind.Bet) {
      return LedgerDirection.Credit;
    }
    if (parentTransaction.kind === WagerTransactionKind.Win) {
      return LedgerDirection.Debit;
    }
    throw new Error(`Cannot determine rollback direction for parent kind: '${parentTransaction.kind}'`);
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(parentTransaction?: WagerTransaction): LedgerDirection {
    if (this.kind === WagerTransactionKind.Bet) {
      return LedgerDirection.Debit;
    }
    if (
      this.kind === WagerTransactionKind.Win ||
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Opening
    ) {
      return LedgerDirection.Credit;
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      if (!parentTransaction) {
        throw new Error("Parent transaction is required to determine Rollback ledger direction");
      }
      return this.determineRollbackDirection(parentTransaction);
    }
    throw new Error(`Transaction kind '${this.kind}' does not generate ledger entries`);
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.status, action);
    }
  }
}
