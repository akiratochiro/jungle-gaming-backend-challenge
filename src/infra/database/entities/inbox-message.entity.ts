import { Entity, PrimaryKeyProp, Property } from '@mikro-orm/core';

/** Composite primary key: (consumerName, messageId). */
@Entity({ tableName: 'inbox_messages' })
export class InboxMessageEntity {
  @Property({ type: 'varchar', length: 64, primary: true })
  consumerName!: string;

  @Property({ type: 'varchar', length: 128, primary: true })
  messageId!: string;

  @Property({ type: 'varchar', length: 64 })
  payloadHash!: string;

  @Property({ type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', nullable: true })
  processedAt?: Date;

  [PrimaryKeyProp]?: ['consumerName', 'messageId'];
}
