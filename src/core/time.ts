export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Formats a UTC epoch-ms timestamp as Asia/Shanghai local time, e.g. "2026-09-30 16:20:05". */
export function formatTime(epochMs: number): string {
  return formatter.format(new Date(epochMs));
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai has no DST.

/** UTC epoch ms of 00:00 on the 1st of the current month in Asia/Shanghai. */
export function startOfMonthShanghai(nowMs: number): number {
  const local = new Date(nowMs + SHANGHAI_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS;
}
