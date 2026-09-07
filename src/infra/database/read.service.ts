import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

export interface LedgerPage {
  entries: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    createdAt: string;
  }>;
  nextCursor: string | null;
}

@Injectable()
export class ReadService {
  constructor(private readonly em: EntityManager) {}

  async wallet(walletId: string) {
    const w = await this.em.findOne(WalletEntity, { id: walletId });
    if (!w) throw new NotFoundException({ error: 'WALLET_NOT_FOUND', message: `Wallet ${walletId} not found` });
    return {
      id: w.id,
      playerId: w.playerId,
      balance: { amount: w.balanceAmount, currency: w.currency },
      version: w.version,
    };
  }

  async ledger(walletId: string, limit: number, cursor?: string): Promise<LedgerPage> {
    const where: Record<string, unknown> = { walletId };
    if (cursor) {
      const { createdAt, id } = decodeCursor(cursor);
      where.$or = [
        { createdAt: { $gt: createdAt } },
        { createdAt, id: { $gt: id } },
      ];
    }
    const rows = await this.em.find(WalletLedgerEntryEntity, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: { amount: e.amount, currency: e.currency },
        balanceBefore: { amount: e.balanceBefore, currency: e.currency },
        balanceAfter: { amount: e.balanceAfter, currency: e.currency },
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async transactionById(id: string) {
    const t = await this.em.findOne(WagerTransactionEntity, { id });
    if (!t) throw new NotFoundException({ error: 'TRANSACTION_NOT_FOUND', message: id });
    return this.txView(t);
  }

  async transactionByProviderRef(providerId: string, externalTransactionId: string) {
    const t = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    if (!t) {
      throw new NotFoundException({ error: 'TRANSACTION_NOT_FOUND', message: `${providerId}:${externalTransactionId}` });
    }
    return this.txView(t);
  }

  /** Recompute the balance from the ledger and compare with the stored balance. */
  async reconcile(walletId: string) {
    const w = await this.em.findOne(WalletEntity, { id: walletId });
    if (!w) throw new NotFoundException({ error: 'WALLET_NOT_FOUND', message: walletId });

    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );

    let calculated = new Decimal(0);
    for (const e of entries) {
      calculated =
        e.direction === 'CREDIT' ? calculated.plus(e.amount) : calculated.minus(e.amount);
    }

    const stored = new Decimal(w.balanceAmount);
    const difference = stored.minus(calculated);
    const consistent = difference.isZero();

    return {
      walletId,
      storedBalance: { amount: stored.toFixed(2), currency: w.currency },
      calculatedBalance: { amount: calculated.toFixed(2), currency: w.currency },
      difference: { amount: difference.toFixed(2), currency: w.currency },
      consistent,
      checkedEntries: entries.length,
    };
  }

  private txView(t: WagerTransactionEntity) {
    return {
      transactionId: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      status: t.status,
      money: { amount: t.amount, currency: t.currency },
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      failureCode: t.failureCode ?? null,
      balance: t.resultBalanceAmount
        ? { amount: t.resultBalanceAmount, currency: t.currency }
        : null,
      processedAt: t.processedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = raw.split('|');
  if (!iso || !id) throw new NotFoundException({ error: 'INVALID_CURSOR', message: 'malformed cursor' });
  return { createdAt: new Date(iso), id };
}
