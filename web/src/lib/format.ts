import type { Account, Transaction } from './api';

const TZ = 'Asia/Shanghai';

/** Splits cents into display parts: "8,000" / ".00", with the sign kept separately. */
export function moneyParts(cents: number): { sign: '' | '-'; int: string; dec: string } {
  const abs = Math.abs(cents);
  const int = Math.trunc(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return { sign: cents < 0 ? '-' : '', int, dec: `.${String(abs % 100).padStart(2, '0')}` };
}

export function formatMoney(cents: number): string {
  const p = moneyParts(cents);
  return `${p.sign}${p.int}${p.dec} 元`;
}

/** Cents -> plain yuan text for inputs, e.g. 150050 -> "1500.5". */
export function centsToInput(cents: number): string {
  return (cents / 100).toString();
}

const parts = (ms: number) => {
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms)) {
    map[p.type] = p.value;
  }
  return map as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;
};

/** "2026-09-30 16:20:05" in Asia/Shanghai. */
export function formatDateTime(ms: number): string {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function formatTime(ms: number): string {
  const p = parts(ms);
  return `${p.hour}:${p.minute}`;
}

export function formatDate(ms: number): string {
  const p = parts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Day heading for grouped lists: 今天 / 昨天 / 9月28日 / 2025年9月28日. */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = parts(ms);
  const key = `${d.year}-${d.month}-${d.day}`;
  if (key === formatDate(now)) return '今天';
  if (key === formatDate(now - 86_400_000)) return '昨天';
  const md = `${Number(d.month)}月${Number(d.day)}日`;
  return d.year === parts(now).year ? md : `${d.year}年${md}`;
}

export type Flow = 'in' | 'out' | 'internal';

/**
 * How a transaction reads from a viewpoint: a specific wallet (account page) or the
 * user as a whole (in = from outside, out = to outside, internal = between own wallets).
 */
export function flowOf(t: Transaction, accountId?: string): Flow {
  if (accountId) return t.to.kind === 'account' && t.to.id === accountId ? 'in' : 'out';
  if (t.from.kind === 'external') return 'in';
  if (t.to.kind === 'external') return 'out';
  return 'internal';
}

export function kindLabel(a: Pick<Account, 'kind'>): string {
  return a.kind === 'player' ? '我的钱包' : 'Agent';
}

export function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}
