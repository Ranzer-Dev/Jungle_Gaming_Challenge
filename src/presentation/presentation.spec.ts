import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import {
  IInboxRepository,
  IOutboxRepository,
  IUnitOfWork,
  IUnitOfWorkContext,
  IWagerTransactionRepository,
  IWalletLedgerRepository,
  IWalletRepository,
} from "../application/ports/repositories.port";
import { CreateWalletUseCase } from "../application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/entities/wager-transaction.entity";
import { Wallet } from "../domain/entities/wallet.aggregate";
import { WalletLedgerEntry } from "../domain/entities/wallet-ledger-entry.entity";
import { InsufficientFundsError } from "../domain/errors/wallet.errors";
import { Money } from "../domain/value-objects/money.value-object";
import { WageringController } from "./controllers/wagering.controller";
import { WalletsController } from "./controllers/wallets.controller";
import { GlobalExceptionFilter } from "./filters/global-exception.filter";

class InMemoryUoW extends IUnitOfWork {
  public walletsList: Wallet[] = [];
  public ledgersList: WalletLedgerEntry[] = [];

  constructor() {
    super();
  }

  public async execute<T>(
    operation: (uowContext: IUnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    const wallets: IWalletRepository = {
      findById: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByIdForUpdate: async (id) => this.walletsList.find((w) => w.id === id) ?? null,
      findByPlayerAndCurrency: async (playerId, currency) =>
        this.walletsList.find((w) => w.playerId === playerId && w.currency === currency) ??
        null,
      persist: (w) => {
        const idx = this.walletsList.findIndex((item) => item.id === w.id);
        if (idx >= 0) this.walletsList[idx] = w;
        else this.walletsList.push(w);
      },
    };

    const transactions: IWagerTransactionRepository = {
      findById: async () => null,
      findByIdempotencyKey: async () => null,
      findByProviderAndExternalId: async () => null,
      findPendingReferences: async () => [],
      persist: () => {},
    };

    const ledger: IWalletLedgerRepository = {
      persist: (entry) => {
        this.ledgersList.push(entry);
      },
      findByWalletId: async (walletId, limit = 20, cursor) => {
        const entries = this.ledgersList.filter((e) => e.walletId === walletId);
        return { entries, nextCursor: undefined, hasMore: false };
      },
      sumCreditsAndDebits: async (walletId) => {
        const wallet = this.walletsList.find((w) => w.id === walletId);
        const currency = wallet?.currency ?? "BRL";
        let totalCredits = Money.zero(currency);
        let totalDebits = Money.zero(currency);
        for (const e of this.ledgersList.filter((l) => l.walletId === walletId)) {
          if (e.direction === "CREDIT") totalCredits = totalCredits.add(e.money);
          else totalDebits = totalDebits.add(e.money);
        }
        return {
          totalCredits: totalCredits.amount,
          totalDebits: totalDebits.amount,
          count: this.ledgersList.filter((l) => l.walletId === walletId).length,
        };
      },
    };

    const inbox: IInboxRepository = {
      find: async () => null,
      persist: () => {},
    };

    const outbox: IOutboxRepository = {
      persist: () => {},
      findPending: async () => [],
    };

    return operation({ wallets, transactions, ledger, inbox, outbox });
  }
}

describe("Presentation Layer", () => {
  describe("WalletsController", () => {
    it("should create wallet and return 201 Created status", async () => {
      const uow = new InMemoryUoW();
      const createWalletUseCase = new CreateWalletUseCase(uow);
      const reconcileWalletUseCase = new ReconcileWalletUseCase(uow);
      const controller = new WalletsController(
        createWalletUseCase,
        reconcileWalletUseCase,
        uow,
      );

      let capturedStatus = 0;
      let capturedBody: unknown = null;
      const resMock = {
        status: (code: number) => {
          capturedStatus = code;
          return {
            json: (body: unknown) => {
              capturedBody = body;
            },
          };
        },
      } as any;

      await controller.createWallet(
        {
          playerId: "p-presentation-1",
          currency: "BRL",
          initialBalance: "150.00",
        },
        "idemp-wallet-pres-1",
        resMock,
      );

      expect(capturedStatus).toBe(201);
      expect((capturedBody as any).balance.amount).toBe("150.00");
    });
  });

  describe("WageringController", () => {
    it("should throw BadRequestException if Idempotency-Key header is missing", async () => {
      const uow = new InMemoryUoW();
      const processTxUseCase = new ProcessWagerTransactionUseCase(uow);
      const controller = new WageringController(processTxUseCase, uow);

      const resMock = {} as any;

      expect(
        controller.processTransaction(
          {
            providerId: "prov-1",
            externalTransactionId: "ext-1",
            playerId: "p-1",
            walletId: "b1b7ef3c-6cc1-447a-8bc2-108b3e34b15c",
            roundId: "r-1",
            gameId: "g-1",
            kind: WagerTransactionKind.Bet,
            amount: "10.00",
            currency: "BRL",
          },
          undefined as any,
          resMock,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("GlobalExceptionFilter", () => {
    it("should format DomainError into RFC 7807 Problem Details response", () => {
      const filter = new GlobalExceptionFilter();
      let capturedStatus = 0;
      let capturedJson: any = null;

      const hostMock = {
        switchToHttp: () => ({
          getRequest: () => ({ url: "/wallets/test-id" }),
          getResponse: () => ({
            status: (code: number) => {
              capturedStatus = code;
              return {
                json: (body: any) => {
                  capturedJson = body;
                },
              };
            },
          }),
        }),
      } as any;

      const error = new InsufficientFundsError("w-1", "10.00", "20.00");
      filter.catch(error, hostMock);

      expect(capturedStatus).toBe(422);
      expect(capturedJson.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect(capturedJson.type).toContain("INSUFFICIENT_FUNDS");
      expect(capturedJson.status).toBe(422);
      expect(capturedJson.instance).toBe("/wallets/test-id");
    });
  });
});
