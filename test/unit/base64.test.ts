import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decodeBase64Url,
  encodeBase64Url,
} from '../../src/base64.ts';

describe('base64', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips unicode strings through base64url', () => {
    const value = 'Grüße 👋 {"page":2}';
    expect(decodeBase64Url(encodeBase64Url(value))).toBe(value);
  });

  it('produces url-safe output without padding', () => {
    const encoded = encodeBase64Url('subjects?_d=1');
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it('encodes known base64 vectors', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello'))).toBe('aGVsbG8=');
  });
});
