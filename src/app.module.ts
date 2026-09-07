import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './infra/infra.module';
import { ApplicationModule } from './application/application.module';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { HealthController } from './http/health.controller';
import { MetricsController } from './http/metrics.controller';
import { CorrelationMiddleware } from './http/correlation.middleware';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), InfraModule, ApplicationModule],
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
