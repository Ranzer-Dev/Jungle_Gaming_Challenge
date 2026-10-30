import { EntityManager, LockMode, QueryOrder } from "@mikro-orm/postgresql";
import { IOutboxRepository } from "../../../application/ports/repositories.port";
import { OutboxMessage } from "../../../domain/entities/outbox-message.entity";

export class MikroOrmOutboxRepository implements IOutboxRepository {
  constructor(private readonly em: EntityManager) {}

  public async save(message: OutboxMessage): Promise<void> {
    this.em.persist(message);
  }

  public async fetchUnpublished(batchSize: number = 50): Promise<OutboxMessage[]> {
    const now = new Date();
    return this.em.find(
      OutboxMessage,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        limit: batchSize,
        orderBy: { occurredAt: QueryOrder.ASC },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // SELECT ... FOR UPDATE SKIP LOCKED
      },
    );
  }

  public async markPublished(id: string): Promise<void> {
    const msg = await this.em.findOne(OutboxMessage, { id });
    if (msg) {
      msg.markPublished();
    }
  }
}
