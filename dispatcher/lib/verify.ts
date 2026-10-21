import { createHmac, timingSafeEqual } from 'node:crypto';

/** Checks GitHub's `x-hub-signature-256` header against the raw request body. */
export function verifySignature(
  body: string,
  header: string | null,
  secret = process.env.GITHUB_WEBHOOK_SECRET,
): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
