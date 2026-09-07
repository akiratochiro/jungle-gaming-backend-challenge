import { Module } from '@nestjs/common';
import { InfraModule } from '../infra/infra.module';
import { PendingReferenceWorker } from '../infra/workers/pending-reference.worker';
import { SqsWagerConsumer } from '../infra/messaging/sqs-wager-consumer';
import { CreateWalletUseCase } from './wallet/create-wallet.use-case';
import { SubmitWagerTransactionUseCase } from './wager/submit-wager-transaction.use-case';
import { ResolvePendingReferenceUseCase } from './wager/resolve-pending-reference.use-case';
import { ApplyReversalService } from './wager/apply-reversal.service';
import { ReferenceResolutionPolicy } from './wager/reference-resolution-policy';

@Module({
  imports: [InfraModule],
  providers: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ResolvePendingReferenceUseCase,
    ApplyReversalService,
    ReferenceResolutionPolicy,
    PendingReferenceWorker,
    SqsWagerConsumer,
  ],
  exports: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ResolvePendingReferenceUseCase,
    PendingReferenceWorker,
    SqsWagerConsumer,
  ],
})
export class ApplicationModule {}
