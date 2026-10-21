import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '@/lib/verify';

const secret = 'shh';
const sign = (body: string, key = secret) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature('{"a":1}', sign('{"a":1}'), secret)).toBe(true);
  });
  it('rejects a tampered body, wrong key, missing header, or missing secret', () => {
    expect(verifySignature('{"a":2}', sign('{"a":1}'), secret)).toBe(false);
    expect(verifySignature('{"a":1}', sign('{"a":1}', 'other'), secret)).toBe(false);
    expect(verifySignature('{"a":1}', null, secret)).toBe(false);
    expect(verifySignature('{"a":1}', 'sha256=abc', secret)).toBe(false);
    expect(verifySignature('{"a":1}', sign('{"a":1}'), undefined)).toBe(false);
  });
});
