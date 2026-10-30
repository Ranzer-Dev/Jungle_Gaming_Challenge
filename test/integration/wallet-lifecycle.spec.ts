import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { LedgerDirection } from "../../src/domain/entities/wallet-ledger-entry.entity";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction.entity";
import { setupIntegrationContext } from "./test-helper";

describe("Integration Test: Wallet Lifecycle & Reconciliation (Real PostgreSQL)", () => {
  let context: Awaited<ReturnType<typeof setupIntegrationContext>>;
  let createWalletUseCase: CreateWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    context = await setupIntegrationContext();
    createWalletUseCase = new CreateWalletUseCase(context.uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(context.uow);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("should create a wallet in PostgreSQL with atomic OPENING transaction and balanced ledger entry", async () => {
    const playerId = `player-${uuidv7()}`;
    const initialAmount = "250.00";

    const walletDto = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: initialAmount, currency: "BRL" },
    });

    expect(walletDto.id).toBeDefined();
    expect(walletDto.playerId).toBe(playerId);
    expect(walletDto.balance.amount).toBe(initialAmount);
    expect(walletDto.balance.currency).toBe("BRL");

    // Consulta direta no banco de dados para verificar consistência física
    await context.uow.execute(async ({ wallets, ledger, transactions }) => {
      const persistedWallet = await wallets.findById(walletDto.id);
      expect(persistedWallet).not.toBeNull();
      expect(persistedWallet?.balance.amount).toBe(initialAmount);

      // Verifica lançamento do ledger (append-only)
      const ledgerResult = await ledger.findByWalletId(walletDto.id, 10);
      expect(ledgerResult.entries.length).toBe(1);
      const openingEntry = ledgerResult.entries[0];
      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.money.amount).toBe(initialAmount);
      expect(openingEntry?.balanceBefore.amount).toBe("0.00");
      expect(openingEntry?.balanceAfter.amount).toBe(initialAmount);

      // Verifica transação OPENING
      const tx = await transactions.findById(openingEntry?.transactionId ?? "");
      expect(tx).not.toBeNull();
      expect(tx?.kind).toBe(WagerTransactionKind.Opening);
      expect(tx?.status).toBe(WagerTransactionStatus.Processed);
    });

    // Auditoria de reconciliação matemática entre ledger e saldo
    const reconciliation = await reconcileWalletUseCase.execute(walletDto.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe(initialAmount);
    expect(reconciliation.calculatedBalance.amount).toBe(initialAmount);
    expect(reconciliation.difference.amount).toBe("0.00");
    expect(reconciliation.checkedEntries).toBe(1);
  });

  it("should paginate ledger entries correctly using Base64 cursor", async () => {
    const playerId = `player-cursor-${uuidv7()}`;
    const walletDto = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // Faz consultas de paginação no ledger
    await context.uow.execute(async ({ ledger }) => {
      const firstPage = await ledger.findByWalletId(walletDto.id, 1);
      expect(firstPage.entries.length).toBe(1);
      expect(firstPage.hasMore).toBe(false); // apenas 1 entry (OPENING)
    });
  });
});
