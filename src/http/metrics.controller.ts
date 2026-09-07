import { Controller, Get, Header } from '@nestjs/common';
import { Metrics } from '../infra/observability/metrics';

/**
 * Prometheus scrape endpoint. Unauthenticated, like the health checks
 * (see ARCHITECTURE.md §Observability).
 */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.render();
  }
}
