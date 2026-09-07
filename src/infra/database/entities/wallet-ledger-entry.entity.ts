import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/wager/enums';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['walletId', 'transactionId'] }) // <= 1 entry per wallet per transaction
@Index({ properties: ['walletId', 'createdAt', 'id'] }) // stable ledger pagination
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'varchar', length: 6 })
  direction!: LedgerDirection;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;
}
