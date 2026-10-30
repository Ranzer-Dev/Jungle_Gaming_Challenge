import { EntityManager } from "@mikro-orm/postgresql";
import {
  IInboxRepository,
  IOutboxRepository,
  IUnitOfWork,
  IWagerTransactionRepository,
  IWalletLedgerRepository,
  IWalletRepository,
} from "../../../application/ports/repositories.port";
import { MikroOrmWalletRepository } from "./mikro-orm-wallet.repository";
import { MikroOrmWagerTransactionRepository } from "./mikro-orm-wager-transaction.repository";
import { MikroOrmWalletLedgerRepository } from "./mikro-orm-wallet-ledger.repository";
import { MikroOrmInboxRepository } from "./mikro-orm-inbox.repository";
import { MikroOrmOutboxRepository } from "./mikro-orm-outbox.repository";

export class MikroOrmUnitOfWork implements IUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  public async execute<T>(
    work: (repositories: {
      wallets: IWalletRepository;
      transactions: IWagerTransactionRepository;
      ledgers: IWalletLedgerRepository;
      inbox: IInboxRepository;
      outbox: IOutboxRepository;
    }) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (forkedEm) => {
      const wallets = new MikroOrmWalletRepository(forkedEm);
      const transactions = new MikroOrmWagerTransactionRepository(forkedEm);
      const ledgers = new MikroOrmWalletLedgerRepository(forkedEm);
      const inbox = new MikroOrmInboxRepository(forkedEm);
      const outbox = new MikroOrmOutboxRepository(forkedEm);

      return work({
        wallets,
        transactions,
        ledgers,
        inbox,
        outbox,
      });
    });
  }
}
