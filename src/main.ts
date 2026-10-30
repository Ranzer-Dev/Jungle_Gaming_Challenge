import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./presentation/filters/global-exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    cors: true,
  });

  // 1. Pipeline de validação global estrita
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );

  // 2. Filtro global de tratamento de exceções (RFC 7807)
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 3. Documentação Swagger/OpenAPI interativa
  const config = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor — Jungle Gaming")
    .setDescription(
      "Sistema de processamento distribuído de apostas e gestão financeira de alta concorrência.",
    )
    .setVersion("1.0.0")
    .addApiKey(
      { type: "apiKey", name: "Idempotency-Key", in: "header" },
      "Idempotency-Key",
    )
    .addApiKey(
      { type: "apiKey", name: "X-Provider-Id", in: "header" },
      "X-Provider-Id",
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document);

  // 4. Ativação de encerramento gracioso (SIGINT, SIGTERM)
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Distributed Wagering Processor running on http://localhost:${port}`);
  console.log(`Swagger documentation available at http://localhost:${port}/docs`);
}

bootstrap();

