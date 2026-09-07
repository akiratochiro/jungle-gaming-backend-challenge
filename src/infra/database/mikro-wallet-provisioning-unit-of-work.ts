import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { uuidv7 } from 'uuidv7';
import { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WalletProvisioningContext,
  WalletProvisioningUnitOfWork,
} from '../../application/wallet/wallet-provisioning-unit-of-work';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { LedgerMapper, WalletMapper, WagerTxMapper } from './mappers';

@Injectable()
export class MikroWalletProvisioningUnitOfWork extends WalletProvisioningUnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async run<T>(fn: (ctx: WalletProvisioningContext) => Promise<T>): Promise<T> {
    return this.em.transactional(async (em) => {
      const ctx: WalletProvisioningContext = {
        async insertWallet(w) {
          const e = WalletMapper.apply(new WalletEntity(), w);
          em.persist(e);
          await em.flush();
        },
        async insertWagerTransaction(tx, resultBalance) {
          em.persist(WagerTxMapper.apply(new WagerTransactionEntity(), tx, resultBalance.amount));
          await em.flush();
        },
        async insertLedgerEntry(entry) {
          em.persist(LedgerMapper.apply(new WalletLedgerEntryEntity(), entry));
          await em.flush();
        },
        async enqueueOutbox(events: ReadonlyArray<IntegrationEvent<unknown>>) {
          for (const event of events) {
            const e = new OutboxMessageEntity();
            e.id = uuidv7();
            e.aggregateId = event.aggregateId;
            e.eventType = event.eventType;
            e.payload = event.toJSON() as unknown as Record<string, unknown>;
            e.occurredAt = event.occurredAt;
            e.attempts = 0;
            e.nextAttemptAt = event.occurredAt;
            e.createdAt = new Date();
            em.persist(e);
          }
          await em.flush();
        },
      };
      return fn(ctx);
    });
  }
}
