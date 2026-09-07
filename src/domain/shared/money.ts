import { Decimal } from 'decimal.js';
import { DomainError, InvalidValueError } from './domain-error';

/** Fixed monetary scale used across the whole system. */
export const MONEY_SCALE = 2;

/** ISO-4217 alpha code, 3 uppercase letters. */
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Plain decimal string, optional leading minus, at most 2 fractional digits.
 * Rejects scientific notation, `NaN`, `Infinity`, empty string and thousands
 * separators by construction.
 */
const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

// decimal.js must never round silently nor emit exponential notation.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -1e9, toExpPos: 1e9 });

export interface MoneyProps {
  amount: string; // decimal string, e.g. "25.00"
  currency: string; // ISO-4217
}

export class MoneyCurrencyMismatchError extends DomainError {
  readonly code = 'MONEY_CURRENCY_MISMATCH';
  constructor(a: string, b: string) {
    super(`Cannot operate on Money of different currencies: ${a} vs ${b}`);
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Entry contract: rejects everything that is not a well-formed, non-negative
   * decimal string with <= 2 fractional digits.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof currency !== 'string' || !CURRENCY_RE.test(currency)) {
      throw new InvalidValueError(`Invalid currency: ${JSON.stringify(currency)}`);
    }
    if (typeof amount !== 'string' || !DECIMAL_RE.test(amount)) {
      throw new InvalidValueError(`Invalid money amount: ${JSON.stringify(amount)}`);
    }

    const dec = new Decimal(amount);
    if (!dec.isFinite()) {
      throw new InvalidValueError(`Non-finite money amount: ${amount}`);
    }
    if (dec.isNegative()) {
      throw new InvalidValueError(`Negative amounts are not allowed on input contracts: ${amount}`);
    }

    // The regex already guarantees <= 2 fractional digits, so this never rounds.
    return new Money(dec, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /**
   * Internal rehydration from already-persisted exact values. Allows negative
   * values (e.g. intermediate results) and does not run entry-contract checks
   * beyond currency/finiteness/scale.
   */
  static rehydrate(props: MoneyProps): Money {
    if (typeof props.currency !== 'string' || !CURRENCY_RE.test(props.currency)) {
      throw new InvalidValueError(`Invalid currency on rehydrate: ${JSON.stringify(props.currency)}`);
    }
    const dec = new Decimal(props.amount);
    if (!dec.isFinite()) {
      throw new InvalidValueError(`Non-finite money amount on rehydrate: ${props.amount}`);
    }
    return new Money(dec, props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }
}
