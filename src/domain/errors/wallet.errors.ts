import { DomainError } from "./domain.error";

export class WalletNotFoundError extends DomainError {
  public readonly failureCode = "WALLET_NOT_FOUND";
  public readonly statusCode = 404;

  constructor(walletId: string) {
    super(`Wallet with id '${walletId}' was not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  public readonly failureCode = "WALLET_ALREADY_EXISTS";
  public readonly statusCode = 409;

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player '${playerId}' and currency '${currency}'`);
  }
}

export class InsufficientFundsError extends DomainError {
  public readonly failureCode = "INSUFFICIENT_FUNDS";
  public readonly statusCode = 422;

  constructor(walletId: string, currentBalance: string, requestedAmount: string) {
    super(
      `Insufficient funds for wallet '${walletId}'. Current balance: ${currentBalance}, requested amount: ${requestedAmount}`,
    );
  }
}

