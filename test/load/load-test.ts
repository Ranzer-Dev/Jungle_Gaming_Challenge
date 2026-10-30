import { v7 as uuidv7 } from "uuid";
import { setupIntegrationContext } from "../integration/test-helper";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/entities/wager-transaction.entity";

interface LatencyStats {
  totalRequests: number;
  durationMs: number;
  throughputRps: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  processedCount: number;
  rejectedCount: number;
  idempotentReplayCount: number;
}

function calculateStats(latencies: number[], durationMs: number, results: any[]): LatencyStats {
  latencies.sort((a, b) => a - b);
  const total = latencies.length;

  const p = (percentile: number) => {
    const idx = Math.min(Math.floor((percentile / 100) * total), total - 1);
    return Number((latencies[idx] ?? 0).toFixed(2));
  };

  const processedCount = results.filter((r) => r.status === WagerTransactionStatus.Processed && !r.idempotentReplay).length;
  const rejectedCount = results.filter((r) => r.status === WagerTransactionStatus.Rejected).length;
  const idempotentReplayCount = results.filter((r) => r.idempotentReplay).length;

  return {
    totalRequests: total,
    durationMs: Number(durationMs.toFixed(2)),
    throughputRps: Number(((total / durationMs) * 1000).toFixed(2)),
    minMs: Number((latencies[0] ?? 0).toFixed(2)),
    p50Ms: p(50),
    p90Ms: p(90),
    p95Ms: p(95),
    p99Ms: p(99),
    maxMs: Number((latencies[total - 1] ?? 0).toFixed(2)),
    processedCount,
    rejectedCount,
    idempotentReplayCount,
  };
}

async function runLoadBenchmark() {
  console.log("================================================================================");
  console.log("  JUNGLE GAMING DISTRIBUTED WAGERING PROCESSOR — HIGH PERFORMANCE BENCHMARK");
  console.log("================================================================================");
  console.log("Starting benchmark against PostgreSQL and LocalStack SQS containers...\n");

  const context = await setupIntegrationContext();
  const createWallet = new CreateWalletUseCase(context.uow);
  const processTx = new ProcessWagerTransactionUseCase(context.uow);
  const reconcile = new ReconcileWalletUseCase(context.uow);

  try {
    // -------------------------------------------------------------------------
    // 1. WARMUP PHASE
    // -------------------------------------------------------------------------
    process.stdout.write("[1/3] Warming up database connection pools and caches... ");
    const warmupPlayer = `warmup-${uuidv7()}`;
    const warmupWallet = await createWallet.execute({
      playerId: warmupPlayer,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    for (let i = 0; i < 20; i++) {
      const txId = `warmup-tx-${i}-${uuidv7()}`;
      await processTx.execute({
        idempotencyKey: `idemp-warmup-${txId}`,
        providerId: "warmup-prov",
        externalTransactionId: txId,
        playerId: warmupPlayer,
        walletId: warmupWallet.id,
        roundId: `round-warmup-${i}`,
        gameId: "warmup-game",
        kind: WagerTransactionKind.Bet,
        money: { amount: "1.00", currency: "BRL" },
      });
    }
    console.log("Done. (20 operations executed)\n");

    // -------------------------------------------------------------------------
    // 2. MULTI-WALLET PARALLEL THROUGHPUT TEST (500 Transactions across 10 Wallets)
    // -------------------------------------------------------------------------
    console.log("[2/3] Running Multi-Wallet Concurrency Benchmark (500 Transactions across 10 Wallets)...");
    const numWallets = 10;
    const txPerWallet = 50;
    const totalMultiTx = numWallets * txPerWallet;

    const wallets = await Promise.all(
      Array.from({ length: numWallets }, (_, i) =>
        createWallet.execute({
          playerId: `multi-player-${i}-${uuidv7()}`,
          initialBalance: { amount: "10000.00", currency: "BRL" },
        }),
      ),
    );

    const multiLatencies: number[] = [];
    const multiResults: any[] = [];

    const startTimeMulti = performance.now();

    // Cria todas as 500 promises concorrentes
    const multiPromises = wallets.flatMap((wallet, wIndex) =>
      Array.from({ length: txPerWallet }, async (_, tIndex) => {
        const txId = `multi-${wIndex}-${tIndex}-${uuidv7()}`;
        const t0 = performance.now();
        const res = await processTx.execute({
          idempotencyKey: `idemp-multi-${txId}`,
          providerId: "pragmatic",
          externalTransactionId: txId,
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: `round-multi-${wIndex}-${tIndex}`,
          gameId: "wolf-gold",
          kind: tIndex % 5 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Bet,
          money: { amount: "10.00", currency: "BRL" },
        });
        const elapsed = performance.now() - t0;
        multiLatencies.push(elapsed);
        multiResults.push(res);
        return res;
      }),
    );

    await Promise.all(multiPromises);
    const durationMulti = performance.now() - startTimeMulti;
    const multiStats = calculateStats(multiLatencies, durationMulti, multiResults);

    console.log("\n  --- MULTI-WALLET BENCHMARK RESULTS ---");
    console.log(`  Total Requests:       ${multiStats.totalRequests}`);
    console.log(`  Execution Time:       ${multiStats.durationMs} ms`);
    console.log(`  Throughput:           ${multiStats.throughputRps} ops/sec (TPS)`);
    console.log(`  Latency Min:          ${multiStats.minMs} ms`);
    console.log(`  Latency p50 (Median): ${multiStats.p50Ms} ms`);
    console.log(`  Latency p90:          ${multiStats.p90Ms} ms`);
    console.log(`  Latency p95:          ${multiStats.p95Ms} ms`);
    console.log(`  Latency p99:          ${multiStats.p99Ms} ms`);
    console.log(`  Latency Max:          ${multiStats.maxMs} ms`);
    console.log(`  Processed:            ${multiStats.processedCount}`);
    console.log(`  Rejected:             ${multiStats.rejectedCount}\n`);

    // -------------------------------------------------------------------------
    // 3. SINGLE HOT WALLET EXTREME CONTENTION (100 Concurrent Requests on 1 Wallet)
    // -------------------------------------------------------------------------
    console.log("[3/3] Running Single Hot-Wallet Contention Benchmark (100 Simultaneous Requests on 1 Wallet)...");
    const hotPlayer = `hot-player-${uuidv7()}`;
    const hotWallet = await createWallet.execute({
      playerId: hotPlayer,
      initialBalance: { amount: "5000.00", currency: "BRL" },
    });

    const hotLatencies: number[] = [];
    const hotResults: any[] = [];
    const numHotRequests = 100;

    const startTimeHot = performance.now();

    const hotPromises = Array.from({ length: numHotRequests }, async (_, i) => {
      const txId = `hot-bench-${i}-${uuidv7()}`;
      const t0 = performance.now();
      const res = await processTx.execute({
        idempotencyKey: `idemp-hot-bench-${txId}`,
        providerId: "evolution",
        externalTransactionId: txId,
        playerId: hotPlayer,
        walletId: hotWallet.id,
        roundId: `round-hot-${i}`,
        gameId: "roulette",
        kind: WagerTransactionKind.Bet,
        money: { amount: "10.00", currency: "BRL" },
      });
      const elapsed = performance.now() - t0;
      hotLatencies.push(elapsed);
      hotResults.push(res);
      return res;
    });

    await Promise.all(hotPromises);
    const durationHot = performance.now() - startTimeHot;
    const hotStats = calculateStats(hotLatencies, durationHot, hotResults);

    console.log("\n  --- SINGLE HOT-WALLET CONTENTION RESULTS ---");
    console.log(`  Total Requests:       ${hotStats.totalRequests}`);
    console.log(`  Execution Time:       ${hotStats.durationMs} ms`);
    console.log(`  Throughput:           ${hotStats.throughputRps} ops/sec (Pessimistic Lock Serialization)`);
    console.log(`  Latency Min:          ${hotStats.minMs} ms`);
    console.log(`  Latency p50:          ${hotStats.p50Ms} ms`);
    console.log(`  Latency p95:          ${hotStats.p95Ms} ms`);
    console.log(`  Latency p99:          ${hotStats.p99Ms} ms`);
    console.log(`  Latency Max:          ${hotStats.maxMs} ms`);
    console.log(`  Processed:            ${hotStats.processedCount}`);
    console.log(`  Rejected:             ${hotStats.rejectedCount}\n`);

    // -------------------------------------------------------------------------
    // 4. FINANCIAL AUDIT & MATHEMATICAL RECONCILIATION
    // -------------------------------------------------------------------------
    process.stdout.write("Running rigorous mathematical reconciliation on all benchmarked wallets... ");
    const allWalletsToAudit = [...wallets, hotWallet];

    for (const w of allWalletsToAudit) {
      const audit = await reconcile.execute(w.id);
      if (!audit.consistent || audit.difference.amount !== "0.00") {
        console.error(`\n[FATAL AUDIT FAILURE] Wallet ${w.id} is inconsistent! Stored: ${audit.storedBalance.amount}, Calculated: ${audit.calculatedBalance.amount}`);
        process.exit(1);
      }
    }
    console.log(`PASSED! All ${allWalletsToAudit.length} wallets are 100% mathematically consistent (Zero discrepancy).\n`);

    console.log("================================================================================");
    console.log("  BENCHMARK COMPLETED SUCCESSFULLY (Zero errors, 100% Financial Integrity)");
    console.log("================================================================================");
  } finally {
    await context.cleanup();
  }
}

runLoadBenchmark().catch((err) => {
  console.error("Benchmark failed with error:", err);
  process.exit(1);
});
