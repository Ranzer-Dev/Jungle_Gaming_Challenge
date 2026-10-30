import { EntityManager, QueryOrder } from "@mikro-orm/postgresql";
import { IWagerTransactionRepository } from "../../../application/ports/repositories.port";
import {
  WagerTransaction,
  WagerTransactionStatus,
} from "../../../domain/entities/wager-transaction.entity";

export class MikroOrmWagerTransactionRepository implements IWagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  public async findById(id: string): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { id });
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { idempotencyKey: key });
  }

  public async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, {
      providerId,
      externalTransactionId: externalId,
    });
  }

  public async findPendingReferences(limit: number = 20): Promise<WagerTransaction[]> {
    return this.em.find(
      WagerTransaction,
      { status: WagerTransactionStatus.PendingReference },
      { limit, orderBy: { createdAt: QueryOrder.ASC } },
    );
  }

  public persist(transaction: WagerTransaction): void {
    this.em.persist(transaction);
  }
}
