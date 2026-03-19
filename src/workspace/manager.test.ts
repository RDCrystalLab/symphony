import { describe, it, expect } from 'vitest';
import { sanitizeIdentifier, getWorkspacePath } from './manager.js';

describe('Workspace Manager', () => {
  describe('sanitizeIdentifier', () => {
    it('preserves valid characters', () => {
      expect(sanitizeIdentifier('ABC-123')).toBe('ABC-123');
      expect(sanitizeIdentifier('test.file')).toBe('test.file');
      expect(sanitizeIdentifier('under_score')).toBe('under_score');
    });

    it('replaces invalid characters with underscore', () => {
      expect(sanitizeIdentifier('foo/bar')).toBe('foo_bar');
      expect(sanitizeIdentifier('a b c')).toBe('a_b_c');
      expect(sanitizeIdentifier('special@#$chars')).toBe('special___chars');
    });
  });

  describe('getWorkspacePath', () => {
    it('computes deterministic path', () => {
      const path = getWorkspacePath('/tmp/workspaces', 'MT-123');
      expect(path).toBe('/tmp/workspaces/MT-123');
    });

    it('sanitizes identifier in path', () => {
      const path = getWorkspacePath('/tmp/workspaces', 'MY PROJ/123');
      expect(path).toBe('/tmp/workspaces/MY_PROJ_123');
    });

    it('sanitizes traversal attempts (slashes become underscores, dots preserved)', () => {
      // Dots are valid per spec [A-Za-z0-9._-], slashes become _
      // ../../../etc/passwd -> .._.._.._etc_passwd which resolves safely under root
      const path = getWorkspacePath('/tmp/workspaces', '../../../etc/passwd');
      expect(path).toBe('/tmp/workspaces/.._.._.._etc_passwd');
      // Verify it stays under root
      expect(path.startsWith('/tmp/workspaces/')).toBe(true);
    });
  });
});
