import { EntityManager } from "@mikro-orm/postgresql";
import {
  IUnitOfWork,
  IUnitOfWorkContext,
} from "../../../application/ports/repositories.port";
import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "./mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "./mikro-orm-wallet-ledger.repository";
import { MikroOrmInboxRepository } from "./mikro-orm-inbox.repository";
import { MikroOrmOutboxRepository } from "./mikro-orm-outbox.repository";

export class MikroOrmUnitOfWork extends IUnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  public async execute<T>(
    operation: (uowContext: IUnitOfWorkContext) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const wallets = new MikroOrmWalletRepository(forkedEm);
      const transactions = new MikroOrmWagerTransactionRepository(forkedEm);
      const ledger = new MikroOrmWalletLedgerRepository(forkedEm);
      const inbox = new MikroOrmInboxRepository(forkedEm);
      const outbox = new MikroOrmOutboxRepository(forkedEm);

      return operation({
        wallets,
        transactions,
        ledger,
        inbox,
        outbox,
      });
    });
  }
}
