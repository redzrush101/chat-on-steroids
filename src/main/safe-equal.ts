import { timingSafeEqual } from 'node:crypto';

/** Compare UTF-8 tokens without a byte-by-byte early exit for equal-length values. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
