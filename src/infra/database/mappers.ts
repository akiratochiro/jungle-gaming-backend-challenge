import { Money } from '../../domain/shared/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

export const WalletMapper = {
  toDomain(e: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: e.id,
      playerId: e.playerId,
      currency: e.currency,
      balance: Money.rehydrate({ amount: e.balanceAmount, currency: e.currency }),
      version: e.version,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
  },
  apply(e: WalletEntity, w: Wallet): WalletEntity {
    e.id = w.id;
    e.playerId = w.playerId;
    e.currency = w.currency;
    e.balanceAmount = w.balance.toString();
    e.version = w.version;
    e.createdAt = w.createdAt;
    e.updatedAt = w.updatedAt;
    return e;
  },
};

export const LedgerMapper = {
  toDomain(e: WalletLedgerEntryEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      money: Money.rehydrate({ amount: e.amount, currency: e.currency }),
      balanceBefore: Money.rehydrate({ amount: e.balanceBefore, currency: e.currency }),
      balanceAfter: Money.rehydrate({ amount: e.balanceAfter, currency: e.currency }),
      createdAt: e.createdAt,
    });
  },
  apply(e: WalletLedgerEntryEntity, l: WalletLedgerEntry): WalletLedgerEntryEntity {
    e.id = l.id;
    e.walletId = l.walletId;
    e.transactionId = l.transactionId;
    e.direction = l.direction;
    e.amount = l.money.toString();
    e.currency = l.money.currency;
    e.balanceBefore = l.balanceBefore.toString();
    e.balanceAfter = l.balanceAfter.toString();
    e.createdAt = l.createdAt;
    return e;
  },
};

export const WagerTxMapper = {
  toDomain(e: WagerTransactionEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: e.id,
      providerId: e.providerId,
      externalTransactionId: e.externalTransactionId,
      idempotencyKey: e.idempotencyKey,
      payloadHash: e.payloadHash,
      walletId: e.walletId,
      playerId: e.playerId,
      roundId: e.roundId,
      gameId: e.gameId,
      kind: e.kind,
      money: Money.rehydrate({ amount: e.amount, currency: e.currency }),
      referenceExternalTransactionId: e.referenceExternalTransactionId,
      createdAt: e.createdAt,
      status: e.status,
      referenceTransactionId: e.referenceTransactionId,
      failureCode: e.failureCode,
      processedAt: e.processedAt,
    });
  },
  apply(
    e: WagerTransactionEntity,
    t: WagerTransaction,
    resultBalanceAmount?: string,
    now: Date = new Date(),
  ): WagerTransactionEntity {
    e.id = t.id;
    e.providerId = t.providerId;
    e.externalTransactionId = t.externalTransactionId;
    e.idempotencyKey = t.idempotencyKey;
    e.payloadHash = t.payloadHash;
    e.walletId = t.walletId;
    e.playerId = t.playerId;
    e.roundId = t.roundId;
    e.gameId = t.gameId;
    e.kind = t.kind;
    e.amount = t.money.toString();
    e.currency = t.money.currency;
    e.referenceExternalTransactionId = t.referenceExternalTransactionId;
    e.status = t.status;
    e.referenceTransactionId = t.referenceTransactionId;
    e.failureCode = t.failureCode;
    e.processedAt = t.processedAt;
    e.balanceChanged = t.affectsBalance() && t.status === 'PROCESSED';
    if (resultBalanceAmount !== undefined) e.resultBalanceAmount = resultBalanceAmount;
    e.createdAt = t.createdAt;
    e.updatedAt = now;
    return e;
  },
};
