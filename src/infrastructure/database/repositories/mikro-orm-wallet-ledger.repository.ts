import { EntityManager, QueryOrder } from "@mikro-orm/postgresql";
import { IWalletLedgerRepository } from "../../../application/ports/repositories.port";
import { WalletLedgerEntry } from "../../../domain/entities/wallet-ledger-entry.entity";

interface LedgerCursorData {
  createdAt: string;
  id: string;
}

export class MikroOrmWalletLedgerRepository implements IWalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  public persist(entry: WalletLedgerEntry): void {
    this.em.persist(entry);
  }

  public async findByWalletId(
    walletId: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<{ entries: WalletLedgerEntry[]; nextCursor?: string; hasMore: boolean }> {
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const qb = this.em.createQueryBuilder(WalletLedgerEntry, "entry");

    qb.where({ walletId });

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded) as LedgerCursorData;
        const cursorDate = new Date(parsed.createdAt);

        qb.andWhere(
          "(entry.created_at < ? OR (entry.created_at = ? AND entry.id < ?))",
          [cursorDate, cursorDate, parsed.id],
        );
      } catch {
        // Ignora cursor inválido
      }
    }

    qb.orderBy({ createdAt: QueryOrder.DESC, id: QueryOrder.DESC });
    qb.limit(effectiveLimit + 1);

    const rows = await qb.getResultList();
    const hasMore = rows.length > effectiveLimit;
    const entries = hasMore ? rows.slice(0, effectiveLimit) : rows;

    let nextCursor: string | undefined = undefined;
    if (hasMore && entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      if (lastEntry) {
        const cursorPayload: LedgerCursorData = {
          createdAt: lastEntry.createdAt.toISOString(),
          id: lastEntry.id,
        };
        nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString("base64");
      }
    }

    return { entries, nextCursor, hasMore };
  }

  public async sumCreditsAndDebits(
    walletId: string,
  ): Promise<{ totalCredits: string; totalDebits: string; count: number }> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<
      Array<{
        total_credits: string;
        total_debits: string;
        entry_count: string;
      }>
    >(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0)::text as total_credits,
         COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0)::text as total_debits,
         COUNT(*)::text as entry_count
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );

    const first = rows[0];
    if (!first) {
      return { totalCredits: "0.00", totalDebits: "0.00", count: 0 };
    }

    return {
      totalCredits: first.total_credits,
      totalDebits: first.total_debits,
      count: parseInt(first.entry_count, 10),
    };
  }
}
