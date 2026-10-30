import { MoneyProps } from "../../domain/value-objects/money.value-object";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/entities/wager-transaction.entity";

// Commands
export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  // Opcional para quando vier de transporte SQS
  sqsMessageId?: string;
  consumerName?: string;
}

// Queries / Responses
export interface WalletDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
}

export interface WalletReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

