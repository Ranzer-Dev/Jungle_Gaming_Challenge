import { EntityManager, LockMode } from "@mikro-orm/postgresql";
import { IWalletRepository } from "../../../application/ports/repositories.port";
import { Wallet } from "../../../domain/entities/wallet.aggregate";

export class MikroOrmWalletRepository implements IWalletRepository {
  constructor(private readonly em: EntityManager) {}

  public async findById(id: string, options?: { lock?: boolean }): Promise<Wallet | null> {
    return this.em.findOne(
      Wallet,
      { id },
      options?.lock ? { lockMode: LockMode.PESSIMISTIC_WRITE } : undefined,
    );
  }

  public async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { playerId, currency });
  }

  public async save(wallet: Wallet): Promise<void> {
    this.em.persist(wallet);
  }
}
