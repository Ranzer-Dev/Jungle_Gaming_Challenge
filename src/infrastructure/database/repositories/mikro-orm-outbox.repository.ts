import { EntityManager, LockMode, QueryOrder } from "@mikro-orm/postgresql";
import { IOutboxRepository } from "../../../application/ports/repositories.port";
import { OutboxMessage } from "../../../domain/entities/outbox-message.entity";

export class MikroOrmOutboxRepository implements IOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  public persist(message: OutboxMessage): void {
    this.em.persist(message);
  }

  public async findPending(limit: number = 50): Promise<OutboxMessage[]> {
    const now = new Date();
    return this.em.find(
      OutboxMessage,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        limit,
        orderBy: { occurredAt: QueryOrder.ASC },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // SELECT ... FOR UPDATE SKIP LOCKED
      },
    );
  }
}
