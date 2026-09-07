import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './infra/infra.module';
import { ApplicationModule } from './application/application.module';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { HealthController } from './http/health.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), InfraModule, ApplicationModule],
  controllers: [WalletsController, WageringController, HealthController],
})
export class AppModule {}
