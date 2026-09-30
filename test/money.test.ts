import { describe, expect, it } from 'vitest';
import { formatCents, parseMoney } from '../src/core/money.js';

describe('parseMoney', () => {
  it('parses yuan into cents without float error', () => {
    expect(parseMoney(8000)).toBe(800000);
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney(0.29)).toBe(29);
    expect(parseMoney('19.99')).toBe(1999);
    expect(parseMoney(' 7 ')).toBe(700);
  });

  it('rejects more than two decimals, garbage and non-finite input', () => {
    for (const bad of ['1.234', 'abc', '', '1e5', '١٢', Number.NaN, Number.POSITIVE_INFINITY, 1e-7, 1e21]) {
      expect(() => parseMoney(bad as number | string)).toThrow(/金额/);
    }
  });

  it('rejects zero and negatives unless allowed', () => {
    expect(() => parseMoney(0)).toThrow(/大于 0/);
    expect(() => parseMoney('-5')).toThrow(/负数/);
    expect(parseMoney(0, { allowZero: true })).toBe(0);
    expect(parseMoney('-0', { allowZero: true, allowNegative: true })).toBe(0);
    expect(parseMoney('-3.5', { allowNegative: true })).toBe(-350);
  });

  it('rejects absurdly large amounts', () => {
    expect(() => parseMoney('10000000000000')).toThrow(/过大/);
  });
});

describe('formatCents', () => {
  it('formats with two decimals and sign', () => {
    expect(formatCents(800000)).toBe('8000.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(-1250)).toBe('-12.50');
    expect(formatCents(0)).toBe('0.00');
  });
});
