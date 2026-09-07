import { Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './database/mikro-orm.config';
import { IdGenerator, Uuidv7Generator } from '../application/ports/id-generator';
import { WagerUnitOfWork } from '../application/ports/wager-unit-of-work';
import { WalletProvisioningUnitOfWork } from '../application/wallet/wallet-provisioning-unit-of-work';
import { MikroWagerUnitOfWork } from './database/mikro-wager-unit-of-work';
import { MikroWalletProvisioningUnitOfWork } from './database/mikro-wallet-provisioning-unit-of-work';
import { ReadService } from './database/read.service';
import { SqsClientProvider } from './messaging/sqs-client.provider';
import { OutboxRelay } from './outbox/outbox-relay';
import { ProviderIdentityPort, NoopProviderIdentity } from './auth/provider-identity.port';
import { AuthGuard } from './auth/noop-auth.guard';

@Global()
@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig)],
  providers: [
    { provide: IdGenerator, useClass: Uuidv7Generator },
    { provide: WagerUnitOfWork, useClass: MikroWagerUnitOfWork },
    { provide: WalletProvisioningUnitOfWork, useClass: MikroWalletProvisioningUnitOfWork },
    { provide: ProviderIdentityPort, useClass: NoopProviderIdentity },
    AuthGuard,
    ReadService,
    SqsClientProvider,
    OutboxRelay,
  ],
  exports: [
    IdGenerator,
    WagerUnitOfWork,
    WalletProvisioningUnitOfWork,
    ProviderIdentityPort,
    AuthGuard,
    ReadService,
    SqsClientProvider,
    OutboxRelay,
  ],
})
export class InfraModule {}
