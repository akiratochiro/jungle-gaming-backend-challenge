import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { WagerTransactionStatus } from '../../domain/wager/enums';
import { uuidv7 } from 'uuidv7';
import { IntegrationEvent } from '../../domain/events/integration-event';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  PersistedWagerSnapshot,
  WagerTxContext,
  WagerUnitOfWork,
} from '../../application/ports/wager-unit-of-work';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { LedgerMapper, WalletMapper, WagerTxMapper } from './mappers';

@Injectable()
export class MikroWagerUnitOfWork extends WagerUnitOfWork {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async runForWallet<T>(
    walletId: string,
    fn: (ctx: WagerTxContext) => Promise<T>,
  ): Promise<T> {
    return this.em.transactional(async (em) => {
      const walletEntity = await em.findOne(
        WalletEntity,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      const wallet = walletEntity ? WalletMapper.toDomain(walletEntity) : null;

      const ctx: WagerTxContext = {
        wallet,

        async findByIdempotencyKey(key): Promise<PersistedWagerSnapshot | null> {
          const row = await em.findOne(WagerTransactionEntity, { idempotencyKey: key });
          if (!row) return null;
          return {
            transaction: WagerTxMapper.toDomain(row),
            resultBalance: row.resultBalanceAmount
              ? { amount: row.resultBalanceAmount, currency: row.currency }
              : undefined,
          };
        },

        async findById(transactionId) {
          const row = await em.findOne(WagerTransactionEntity, { id: transactionId });
          return row ? WagerTxMapper.toDomain(row) : null;
        },

        async findByProviderRef(providerId, externalTransactionId) {
          const row = await em.findOne(WagerTransactionEntity, {
            providerId,
            externalTransactionId,
          });
          return row ? WagerTxMapper.toDomain(row) : null;
        },

        async findReversal(referenceTransactionId, kind) {
          const row = await em.findOne(WagerTransactionEntity, {
            referenceTransactionId,
            kind,
            status: WagerTransactionStatus.Processed,
          });
          return row ? WagerTxMapper.toDomain(row) : null;
        },

        async insertWagerTransaction(tx: WagerTransaction, resultBalance) {
          const e = WagerTxMapper.apply(
            new WagerTransactionEntity(),
            tx,
            resultBalance?.amount,
          );
          em.persist(e);
          await em.flush();
        },

        async updateWagerTransaction(tx: WagerTransaction, resultBalance) {
          const e = await em.findOneOrFail(WagerTransactionEntity, { id: tx.id });
          WagerTxMapper.apply(e, tx, resultBalance?.amount);
          await em.flush();
        },

        async saveWallet(w) {
          if (!walletEntity) throw new Error('saveWallet called for a non-existent wallet');
          WalletMapper.apply(walletEntity, w);
          await em.flush();
        },

        async insertLedgerEntry(entry: WalletLedgerEntry) {
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

        async claimInbox(consumerName, messageId, payloadHash) {
          const existing = await em.findOne(InboxMessageEntity, { consumerName, messageId });
          if (existing) return false;
          const e = new InboxMessageEntity();
          e.consumerName = consumerName;
          e.messageId = messageId;
          e.payloadHash = payloadHash;
          e.receivedAt = new Date();
          em.persist(e);
          await em.flush();
          return true;
        },

        async markInboxProcessed(consumerName, messageId) {
          const e = await em.findOne(InboxMessageEntity, { consumerName, messageId });
          if (e) {
            e.processedAt = new Date();
            await em.flush();
          }
        },
      };

      return fn(ctx);
    });
  }
}
