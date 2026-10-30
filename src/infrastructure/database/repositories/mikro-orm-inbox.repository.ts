import { EntityManager } from "@mikro-orm/postgresql";
import { IInboxRepository } from "../../../application/ports/repositories.port";
import { InboxMessage } from "../../../domain/entities/inbox-message.entity";

export class MikroOrmInboxRepository implements IInboxRepository {
  constructor(private readonly em: EntityManager) {}

  public async isConsumed(consumerName: string, messageId: string): Promise<boolean> {
    const count = await this.em.count(InboxMessage, { consumerName, messageId });
    return count > 0;
  }

  public async save(message: InboxMessage): Promise<void> {
    this.em.persist(message);
  }
}
