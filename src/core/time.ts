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
