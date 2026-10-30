import { DomainError } from "./domain.error";

export class InvalidMoneyAmountError extends DomainError {
  public readonly failureCode = "INVALID_MONEY_AMOUNT";
  public readonly statusCode = 400;

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  public readonly failureCode = "CURRENCY_MISMATCH";
  public readonly statusCode = 422;

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected '${expected}', but received '${received}'`);
  }
}

