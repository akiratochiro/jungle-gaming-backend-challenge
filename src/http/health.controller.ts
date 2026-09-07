import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsClientProvider } from '../infra/messaging/sqs-client.provider';

@Controller('health')
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsClientProvider,
  ) {}

  /** Liveness — process is up. No dependency checks. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness — PostgreSQL and SQS reachable. */
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | string> = {};

    try {
      await this.em.getConnection().execute('SELECT 1');
      checks.postgres = 'ok';
    } catch (e) {
      checks.postgres = String(e);
    }

    try {
      await this.sqs.healthCheck();
      checks.sqs = 'ok';
    } catch (e) {
      checks.sqs = String(e);
    }

    const ready = Object.values(checks).every((v) => v === 'ok');
    if (!ready) {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}
