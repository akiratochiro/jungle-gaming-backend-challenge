import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { InfraModule } from './infra/infra.module';
import { CreateWalletUseCase } from './application/wallet/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './application/wager/submit-wager-transaction.use-case';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { HealthController } from './http/health.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), InfraModule],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [CreateWalletUseCase, SubmitWagerTransactionUseCase],
})
export class AppModule {}
