import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../domain/wager/enums';
import { FailureCode } from '../../../domain/wager/failure-code';

@Entity({ tableName: 'wager_transactions' })
@Unique({ properties: ['idempotencyKey'] })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Index({ properties: ['status', 'nextAttemptAt'] }) // pending-reference worker scan
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 128 })
  providerId!: string;

  @Property({ type: 'varchar', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'varchar', length: 320 })
  idempotencyKey!: string;

  @Property({ type: 'varchar', length: 64 })
  payloadHash!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'varchar', length: 128 })
  roundId!: string;

  @Property({ type: 'varchar', length: 128 })
  gameId!: string;

  @Property({ type: 'varchar', length: 12 })
  kind!: WagerTransactionKind;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ type: 'varchar', length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @Property({ type: 'varchar', length: 20 })
  status!: WagerTransactionStatus;

  @Property({ type: 'uuid', nullable: true })
  referenceTransactionId?: string;

  @Property({ type: 'varchar', length: 48, nullable: true })
  failureCode?: FailureCode;

  @Property({ type: 'int' })
  referenceAttempts: number = 0;

  @Property({ type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  /** Wallet balance observed at processing time — replayed verbatim (rule 7). */
  @Property({ type: 'decimal', precision: 20, scale: 2, nullable: true })
  resultBalanceAmount?: string;

  /** true when this processed transaction actually moved the balance. */
  @Property({ type: 'boolean' })
  balanceChanged: boolean = false;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz' })
  updatedAt!: Date;
}
