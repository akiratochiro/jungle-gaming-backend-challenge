import { describe, expect, it } from 'bun:test';
import { Money, MoneyCurrencyMismatchError } from './money';
import { InvalidValueError } from './domain-error';

describe('Money.from', () => {
  it('accepts a well-formed 2-decimal string', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toString()).toBe('25.00');
    expect(m.currency).toBe('BRL');
  });

  it('normalises scale to exactly 2 places', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).toString()).toBe('25.50');
  });

  it.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '',
    ' ',
    '25.001',
    '25.999',
    '1,000.00',
    'abc',
    '.5',
    '5.',
  ])('rejects invalid input %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidValueError);
  });

  it('rejects negative amounts on the entry contract', () => {
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidValueError);
  });

  it('rejects invalid currency codes', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidValueError);
    expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidValueError);
  });
});

describe('Money arithmetic', () => {
  const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

  it('is immutable — operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('15.00');
  });

  it('adds and subtracts exactly', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('negate produces a negative instance', () => {
    const n = brl('5.00').negate();
    expect(n.isNegative()).toBe(true);
    expect(n.toString()).toBe('-5.00');
  });

  it('comparisons', () => {
    expect(brl('5.00').isLessThan(brl('5.01'))).toBe(true);
    expect(brl('5.00').isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('5.00').equals(brl('5.00'))).toBe(true);
  });

  it('throws on currency mismatch', () => {
    expect(() => brl('5.00').add(Money.from({ amount: '5.00', currency: 'USD' }))).toThrow(
      MoneyCurrencyMismatchError,
    );
  });

  it('serialises back to the wire format', () => {
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});
