import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './http/domain-exception.filter';
import { OutboxRelay } from './infra/outbox/outbox-relay';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableShutdownHooks();

  // Run the outbox relay in-process (it is also safe to run as a dedicated worker).
  if (process.env.OUTBOX_RELAY_ENABLED !== 'false') {
    app.get(OutboxRelay).start();
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('bootstrap').log(`HTTP listening on :${port}`);
}

void bootstrap();
