import { WalletError } from './errors.js';

/** Upper bound for any single amount: 1 trillion yuan, comfortably inside Number.MAX_SAFE_INTEGER cents. */
const MAX_CENTS = 100_000_000_000_000;

const MONEY_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export interface ParseMoneyOptions {
  allowZero?: boolean;
  allowNegative?: boolean;
}

/**
 * Parses a yuan amount (number or string, at most 2 decimals) into integer cents.
 * Parses the decimal text rather than multiplying floats, so 0.1 + 0.2 style errors cannot occur.
 */
export function parseMoney(input: number | string, opts: ParseMoneyOptions = {}): number {
  const text = typeof input === 'number' ? numberToPlainString(input) : input.trim();
  const m = text === null ? null : MONEY_RE.exec(text);
  if (!m) {
    throw new WalletError('INVALID_AMOUNT', `金额格式无效：${String(input)}。请使用元为单位、最多两位小数的数字，例如 8000 或 12.5。`);
  }
  const [, sign, intPart, frac = ''] = m;
  const cents = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  const value = sign ? -cents : cents;

  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new WalletError('INVALID_AMOUNT', `金额过大：${String(input)}。`);
  }
  if (value < 0 && !opts.allowNegative) {
    throw new WalletError('INVALID_AMOUNT', `金额不能为负数：${String(input)}。`);
  }
  if (value === 0 && !opts.allowZero) {
    throw new WalletError('INVALID_AMOUNT', '金额必须大于 0。');
  }
  return value === 0 ? 0 : value; // normalise -0
}

function numberToPlainString(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  const s = String(n);
  return /e/i.test(s) ? null : s;
}

/** Formats integer cents as a yuan string with two decimals, e.g. 800000 -> "8000.00", -5 -> "-0.05". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${sign}${yuan}.${fen}`;
}
