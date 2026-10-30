import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { v7 as uuidv7 } from "uuid";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/entities/wager-transaction.entity";
import { setupIntegrationContext } from "./test-helper";

describe("Integration Test: Wagering Lifecycle Flow & Immutability Trigger (Real PostgreSQL)", () => {
  let context: Awaited<ReturnType<typeof setupIntegrationContext>>;
  let createWalletUseCase: CreateWalletUseCase;
  let processTxUseCase: ProcessWagerTransactionUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    context = await setupIntegrationContext();
    createWalletUseCase = new CreateWalletUseCase(context.uow);
    processTxUseCase = new ProcessWagerTransactionUseCase(context.uow);
    reconcileWalletUseCase = new ReconcileWalletUseCase(context.uow);
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("should process BET -> WIN -> REFUND -> ROLLBACK and maintain absolute financial integrity", async () => {
    const playerId = `player-${uuidv7()}`;
    const providerId = "pragmatic";
    const roundId = `round-${uuidv7()}`;
    const gameId = "wolf-gold";

    // 1. Cria carteira com 100.00 BRL
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    });

    // 2. Processa BET de 30.00 BRL (Saldo esperado: 70.00)
    const betExternalId = `bet-${uuidv7()}`;
    const betResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${betExternalId}`,
      providerId,
      externalTransactionId: betExternalId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId,
      kind: WagerTransactionKind.Bet,
      money: { amount: "30.00", currency: "BRL" },
    });

    expect(betResult.status).toBe(WagerTransactionStatus.Processed);
    expect(betResult.balance.amount).toBe("70.00");
    expect(betResult.idempotentReplay).toBe(false);

    // 3. Processa WIN de 50.00 BRL (Saldo esperado: 120.00)
    const winExternalId = `win-${uuidv7()}`;
    const winResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${winExternalId}`,
      providerId,
      externalTransactionId: winExternalId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId,
      kind: WagerTransactionKind.Win,
      money: { amount: "50.00", currency: "BRL" },
    });

    expect(winResult.status).toBe(WagerTransactionStatus.Processed);
    expect(winResult.balance.amount).toBe("120.00");

    // 4. Processa REFUND da BET de 30.00 BRL (Saldo esperado: 150.00)
    const refundExternalId = `refund-${uuidv7()}`;
    const refundResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${refundExternalId}`,
      providerId,
      externalTransactionId: refundExternalId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId,
      kind: WagerTransactionKind.Refund,
      money: { amount: "30.00", currency: "BRL" },
      referenceExternalTransactionId: betExternalId,
    });

    expect(refundResult.status).toBe(WagerTransactionStatus.Processed);
    expect(refundResult.balance.amount).toBe("150.00");

    // 5. Processa ROLLBACK do WIN de 50.00 BRL (Saldo esperado: 100.00)
    const rollbackExternalId = `rollback-${uuidv7()}`;
    const rollbackResult = await processTxUseCase.execute({
      idempotencyKey: `idemp-${rollbackExternalId}`,
      providerId,
      externalTransactionId: rollbackExternalId,
      playerId,
      walletId: wallet.id,
      roundId,
      gameId,
      kind: WagerTransactionKind.Rollback,
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: winExternalId,
    });

    expect(rollbackResult.status).toBe(WagerTransactionStatus.Processed);
    expect(rollbackResult.balance.amount).toBe("100.00");

    // 6. Auditoria de Reconciliação Matemática
    const recon = await reconcileWalletUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("100.00");
    expect(recon.calculatedBalance.amount).toBe("100.00");
    expect(recon.difference.amount).toBe("0.00");
    expect(recon.checkedEntries).toBe(5); // 1 OPENING + 1 BET + 1 WIN + 1 REFUND + 1 ROLLBACK
  });

  it("should actively enforce PostgreSQL trigger preventing UPDATE or DELETE on ledger entries", async () => {
    const conn = context.orm.em.getConnection();

    // Tentar executar um UPDATE manual direto no SQL para provar a Lei 5 de AGENTS.md
    expect(
      conn.execute("UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id IS NOT NULL"),
    ).rejects.toThrow(/Ledger entries are strictly immutable/);

    // Tentar executar um DELETE manual direto no SQL
    expect(
      conn.execute("DELETE FROM wallet_ledger_entries WHERE id IS NOT NULL"),
    ).rejects.toThrow(/Ledger entries are strictly immutable/);
  });
});
