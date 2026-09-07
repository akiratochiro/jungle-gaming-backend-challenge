import { Money } from '../shared/money';
import { DomainError } from '../shared/domain-error';
import {
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
  isTerminalStatus,
} from './enums';
import { FailureCode } from './failure-code';
import { InvalidTransactionStateError } from './errors';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'money' | 'createdAt'> {
  money: Money;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  referenceResolutionAttempts?: number;
  nextReferenceAttemptAt?: Date;
}

const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

class ReferenceRequiredError extends DomainError {
  readonly code = 'REFERENCE_REQUIRED';
  constructor(kind: WagerTransactionKind) {
    super(`${kind} requires referenceExternalTransactionId`);
  }
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _referenceResolutionAttempts: number = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Born in PENDING. Validates the per-kind reference requirement. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !props.referenceExternalTransactionId) {
      throw new ReferenceRequiredError(props.kind);
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstruction from persistence — does NOT revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.referenceResolutionAttempts ?? 0,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get referenceResolutionAttempts(): number {
    return this._referenceResolutionAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions -------------------------------------------------------

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (isTerminalStatus(this._status)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
  }

  /**
   * Park the transaction until its referenced transaction shows up. Each call
   * counts as one resolution attempt and schedules the next retry.
   */
  markPendingReference(nextAttemptAt: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceResolutionAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /** true once the reference has been chased `maxAttempts` times without luck. */
  hasExhaustedReferenceResolution(maxAttempts: number): boolean {
    return this._referenceResolutionAttempts >= maxAttempts;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  // ---- domain queries ---------------------------------------------------

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  /** false for LOSS — it records a result without moving the balance. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Ledger direction this transaction produces. ROLLBACK needs the reference
   * to know which direction to invert; every other kind is self-determined.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new ReferenceRequiredError(this.kind);
        }
        const refDir = reference.ledgerDirectionFor();
        return refDir === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new LossHasNoLedgerError();
    }
  }
}

class LossHasNoLedgerError extends DomainError {
  readonly code = 'LOSS_HAS_NO_LEDGER';
  constructor() {
    super('LOSS transactions do not produce a ledger entry');
  }
}
