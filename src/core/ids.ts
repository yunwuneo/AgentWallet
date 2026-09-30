import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

/** Short, URL-safe random id with a type prefix, e.g. `tx_8f3k2m9q7w1c`. */
export function newId(prefix: string, length = 12): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return `${prefix}_${out}`;
}
