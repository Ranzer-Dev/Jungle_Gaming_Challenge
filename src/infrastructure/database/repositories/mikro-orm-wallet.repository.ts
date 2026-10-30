import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { IWalletRepository } from "../../../application/ports/repositories.port";
import { Wallet } from "../../../domain/entities/wallet.aggregate";

export class MikroOrmWalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) {}

  public async findById(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id });
  }

  public async findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }

  public async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { playerId, currency });
  }

  public persist(wallet: Wallet): void {
    this.em.persist(wallet);
  }
}
