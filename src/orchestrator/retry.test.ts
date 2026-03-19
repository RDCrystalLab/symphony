import { describe, it, expect } from 'vitest';
import { computeRetryDelay } from './retry.js';

describe('Retry Logic', () => {
  describe('computeRetryDelay', () => {
    it('returns 1000ms for continuation retries', () => {
      expect(computeRetryDelay(1, 300000, true)).toBe(1000);
      expect(computeRetryDelay(5, 300000, true)).toBe(1000);
    });

    it('returns exponential backoff for failure retries', () => {
      // 10000 * 2^0 = 10000
      expect(computeRetryDelay(1, 300000, false)).toBe(10000);
      // 10000 * 2^1 = 20000
      expect(computeRetryDelay(2, 300000, false)).toBe(20000);
      // 10000 * 2^2 = 40000
      expect(computeRetryDelay(3, 300000, false)).toBe(40000);
      // 10000 * 2^3 = 80000
      expect(computeRetryDelay(4, 300000, false)).toBe(80000);
    });

    it('caps at max backoff', () => {
      expect(computeRetryDelay(10, 300000, false)).toBe(300000);
      expect(computeRetryDelay(20, 300000, false)).toBe(300000);
    });

    it('respects custom max backoff', () => {
      expect(computeRetryDelay(5, 50000, false)).toBe(50000);
    });
  });
});
