import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  /** exact decimal, 2-scale; mapped to/from string */
  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAmount!: string;

  @Property({ type: 'int' })
  version!: number;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz' })
  updatedAt!: Date;
}
