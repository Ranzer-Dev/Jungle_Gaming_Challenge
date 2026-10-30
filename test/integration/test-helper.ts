import { MikroORM } from "@mikro-orm/postgresql";
import { SQSClient } from "@aws-sdk/client-sqs";
import mikroOrmConfig from "../../src/infrastructure/database/mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/database/repositories/mikro-orm-unit-of-work";
import { SqsQueuePublisher } from "../../src/infrastructure/messaging/sqs-queue-publisher";

export async function setupIntegrationContext(): Promise<{
  orm: MikroORM;
  uow: MikroOrmUnitOfWork;
  sqsClient: SQSClient;
  sqsPublisher: SqsQueuePublisher;
  cleanup: () => Promise<void>;
}> {
  const orm = await MikroORM.init({
    ...mikroOrmConfig,
    debug: false,
  });

  const uow = new MikroOrmUnitOfWork(orm.em);

  const sqsClient = new SQSClient({
    region: "us-east-1",
    endpoint: process.env.LOCALSTACK_ENDPOINT || "http://localhost:4566",
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  });

  const sqsPublisher = new SqsQueuePublisher({
    queueUrl:
      process.env.SQS_OUTBOX_QUEUE_URL ||
      "http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/integration-events.fifo",
    endpoint: "http://localhost:4566",
  });

  const cleanup = async () => {
    await orm.close();
  };

  return { orm, uow, sqsClient, sqsPublisher, cleanup };
}
