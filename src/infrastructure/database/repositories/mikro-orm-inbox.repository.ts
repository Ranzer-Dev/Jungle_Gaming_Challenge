import { EntityManager } from "@mikro-orm/postgresql";
import { IInboxRepository } from "../../../application/ports/repositories.port";
import { InboxMessage } from "../../../domain/entities/inbox-message.entity";

export class MikroOrmInboxRepository implements IInboxRepository {
  constructor(private readonly em: EntityManager) {}

  public async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    return this.em.findOne(InboxMessage, { consumerName, messageId });
  }

  public persist(message: InboxMessage): void {
    this.em.persist(message);
  }
}
