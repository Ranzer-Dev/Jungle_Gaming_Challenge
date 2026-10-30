import { EntityManager, QueryOrder } from "@mikro-orm/postgresql";
import { IWalletLedgerRepository } from "../../../application/ports/repositories.port";
import { WalletLedgerEntry } from "../../../domain/entities/wallet-ledger-entry.entity";
import { Money } from "../../../domain/value-objects/money.value-object";

interface LedgerCursorData {
  createdAt: string;
  id: string;
}

export class MikroOrmWalletLedgerRepository implements IWalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  public async save(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(entry);
  }

  public async findByWalletId(
    walletId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<{ entries: WalletLedgerEntry[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const qb = this.em.createQueryBuilder(WalletLedgerEntry, "entry");

    qb.where({ walletId });

    if (options?.cursor) {
      try {
        const decoded = Buffer.from(options.cursor, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded) as LedgerCursorData;
        const cursorDate = new Date(parsed.createdAt);

        qb.andWhere(
          "(entry.created_at < :cursorDate OR (entry.created_at = :cursorDate AND entry.id < :cursorId))",
          {
            cursorDate,
            cursorId: parsed.id,
          },
        );
      } catch {
        // Ignora cursor malformado e faz query do início
      }
    }

    qb.orderBy({ createdAt: QueryOrder.DESC, id: QueryOrder.DESC });
    qb.limit(limit + 1);

    const rows = await qb.getResultList();
    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
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

    return { entries, nextCursor };
  }

  public async sumCredits(walletId: string): Promise<Money> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<Array<{ total: string; currency: string }>>(
      `SELECT w.currency, COALESCE(SUM(l.amount), 0)::text as total
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id AND l.direction = 'CREDIT'
       WHERE w.id = ?
       GROUP BY w.currency`,
      [walletId],
    );

    const first = rows[0];
    if (!first) {
      return Money.zero("USD");
    }

    return Money.from({ amount: first.total, currency: first.currency });
  }

  public async sumDebits(walletId: string): Promise<Money> {
    const conn = this.em.getConnection();
    const rows = await conn.execute<Array<{ total: string; currency: string }>>(
      `SELECT w.currency, COALESCE(SUM(l.amount), 0)::text as total
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id AND l.direction = 'DEBIT'
       WHERE w.id = ?
       GROUP BY w.currency`,
      [walletId],
    );

    const first = rows[0];
    if (!first) {
      return Money.zero("USD");
    }

    return Money.from({ amount: first.total, currency: first.currency });
  }
}
