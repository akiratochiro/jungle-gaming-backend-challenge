import { Injectable, Logger } from '@nestjs/common';
import { Money, MoneyProps } from '../../domain/shared/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager/enums';
import { Metrics } from '../../infra/observability/metrics';
import { enrichCorrelation } from '../../infra/observability/correlation';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/events/wager-events';
import { sha256CanonicalHex } from '../../domain/shared/canonical-json';
import { IdGenerator } from '../ports/id-generator';
import { WalletProvisioningUnitOfWork } from './wallet-provisioning-unit-of-work';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  private readonly logger = new Logger(CreateWalletUseCase.name);

  constructor(
    private readonly uow: WalletProvisioningUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(cmd: CreateWalletCommand): Promise<CreateWalletResult> {
    const initial = Money.from(cmd.initialBalance);
    const walletId = this.ids.next();
    const wallet = Wallet.open({ id: walletId, playerId: cmd.playerId, initialBalance: initial });
    enrichCorrelation({ walletId });

    let openingBooked = false;
    await this.uow.run(async (ctx) => {
      await ctx.insertWallet(wallet);

      if (!initial.isPositive()) return;

      const txId = this.ids.next();
      const externalId = `opening:${walletId}`;
      const openingBusiness = {
        providerId: 'internal',
        externalTransactionId: externalId,
        playerId: cmd.playerId,
        walletId,
        kind: WagerTransactionKind.Opening,
        money: initial.toJSON(),
      };
      const tx = WagerTransaction.create({
        id: txId,
        providerId: 'internal',
        externalTransactionId: externalId,
        idempotencyKey: `internal:${externalId}`,
        payloadHash: sha256CanonicalHex(openingBusiness),
        walletId,
        playerId: cmd.playerId,
        roundId: externalId,
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: initial,
      });
      const entry = wallet.openingEntry({ transactionId: txId, ledgerEntryId: this.ids.next() });
      tx.markProcessed(undefined, wallet.createdAt);

      await ctx.insertWagerTransaction(tx, wallet.balance.toJSON());
      await ctx.insertLedgerEntry(entry);

      const eventCtx = { correlationId: cmd.correlationId, causationId: txId };
      const events: IntegrationEvent<unknown>[] = [
        WagerTransactionProcessed.from(tx, eventCtx),
        WalletBalanceChanged.from(wallet, entry, eventCtx),
      ];
      await ctx.enqueueOutbox(events);
      enrichCorrelation({ transactionId: txId });
      openingBooked = true;
    });

    if (openingBooked) {
      this.metrics.wagerTransactions.inc({
        status: WagerTransactionStatus.Processed,
        kind: WagerTransactionKind.Opening,
      });
    }
    this.logger.log({ msg: 'wallet opened', openingBooked });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
