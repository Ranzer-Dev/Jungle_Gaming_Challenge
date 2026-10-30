import { Module, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import mikroOrmConfig from "./infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "./infrastructure/database/repositories/mikro-orm-unit-of-work";
import { SqsQueuePublisher } from "./infrastructure/messaging/sqs-queue-publisher";
import { DefaultProviderIdentityService } from "./infrastructure/security/provider-identity.service";
import { OutboxPublisherWorker } from "./infrastructure/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "./infrastructure/workers/pending-reference.worker";
import { HealthController } from "./presentation/controllers/health.controller";
import { WageringController } from "./presentation/controllers/wagering.controller";
import { WalletsController, UNIT_OF_WORK_PORT } from "./presentation/controllers/wallets.controller";
import { PROVIDER_IDENTITY_PORT, ProviderAuthGuard } from "./presentation/guards/provider-auth.guard";

@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    // 1. Database & ORM
    {
      provide: "MikroORM",
      useFactory: async () => {
        return await MikroORM.init(mikroOrmConfig);
      },
    },
    {
      provide: "EntityManager",
      useFactory: (orm: MikroORM) => {
        return orm.em;
      },
      inject: ["MikroORM"],
    },
    {
      provide: UNIT_OF_WORK_PORT,
      useFactory: (orm: MikroORM) => {
        return new MikroOrmUnitOfWork(orm.em);
      },
      inject: ["MikroORM"],
    },

    // 2. Identity & Security
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: DefaultProviderIdentityService,
    },
    ProviderAuthGuard,

    // 3. Application Use Cases
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: MikroOrmUnitOfWork) => {
        return new CreateWalletUseCase(uow);
      },
      inject: [UNIT_OF_WORK_PORT],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (uow: MikroOrmUnitOfWork) => {
        return new ProcessWagerTransactionUseCase(uow);
      },
      inject: [UNIT_OF_WORK_PORT],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (uow: MikroOrmUnitOfWork) => {
        return new ReconcileWalletUseCase(uow);
      },
      inject: [UNIT_OF_WORK_PORT],
    },

    // 5. Messaging & Workers
    {
      provide: SqsQueuePublisher,
      useFactory: () => {
        return new SqsQueuePublisher();
      },
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (uow: MikroOrmUnitOfWork, publisher: SqsQueuePublisher) => {
        return new OutboxPublisherWorker(uow, publisher);
      },
      inject: [UNIT_OF_WORK_PORT, SqsQueuePublisher],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (uow: MikroOrmUnitOfWork) => {
        return new PendingReferenceWorker(uow);
      },
      inject: [UNIT_OF_WORK_PORT],
    },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly outboxWorker: OutboxPublisherWorker,
    private readonly pendingWorker: PendingReferenceWorker,
  ) {}

  public onApplicationBootstrap(): void {
    // Inicia os workers desacoplados em segundo plano
    if (process.env.START_WORKERS !== "false") {
      this.outboxWorker.start();
      this.pendingWorker.start();
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    // Finalização graciosa garantindo commit de operações em trânsito
    await this.outboxWorker.stop();
    await this.pendingWorker.stop();
  }
}
