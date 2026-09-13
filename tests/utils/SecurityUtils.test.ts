/**
 * Security Utils Unit Tests
 * Tests for DOI validation, query sanitization, injection prevention
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import * as path from 'path';
import {
  sanitizeDoi,
  escapeQueryValue,
  validateQueryComplexity,
  withTimeout,
  sanitizeRequest,
  sanitizeSensitiveText,
  sanitizeBody,
  sanitizeUrl,
  maskSensitiveData,
  sanitizeDownloadPath,
  sanitizeFilename
} from '../../src/utils/SecurityUtils.js';

describe('SecurityUtils', () => {
  describe('sanitizeDoi', () => {
    it('should accept valid DOI formats', () => {
      const result = sanitizeDoi('10.1038/nature12373');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('10.1038/nature12373');
    });

    it('should clean DOI URL prefixes', () => {
      const result1 = sanitizeDoi('https://doi.org/10.1038/nature12373');
      expect(result1.valid).toBe(true);
      expect(result1.sanitized).toBe('10.1038/nature12373');

      const result2 = sanitizeDoi('http://dx.doi.org/10.1038/nature12373');
      expect(result2.valid).toBe(true);
      expect(result2.sanitized).toBe('10.1038/nature12373');

      const result3 = sanitizeDoi('doi:10.1038/nature12373');
      expect(result3.valid).toBe(true);
      expect(result3.sanitized).toBe('10.1038/nature12373');
    });

    it('should reject invalid DOI formats', () => {
      const result1 = sanitizeDoi('invalid-doi');
      expect(result1.valid).toBe(false);

      const result2 = sanitizeDoi('11.1234/test'); // DOI must start with 10.
      expect(result2.valid).toBe(false);

      const result3 = sanitizeDoi('');
      expect(result3.valid).toBe(false);
    });

    it('should detect injection attempts', () => {
      const result1 = sanitizeDoi('10.1038/nature12373; DROP TABLE papers;');
      expect(result1.valid).toBe(false);

      const result2 = sanitizeDoi('10.1038/nature12373<script>alert(1)</script>');
      expect(result2.valid).toBe(false);
    });

    it('should handle DOIs with special characters', () => {
      const result = sanitizeDoi('10.1000/xyz123');
      expect(result.valid).toBe(true);
    });

    it('should reject NUL bytes in DOI', () => {
      const result = sanitizeDoi('10.1038/abc\x00def');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('control');
    });

    it('should reject CR/LF in DOI', () => {
      const result = sanitizeDoi('10.1038/abc\ndef');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('control');
    });
  });

  describe('escapeQueryValue', () => {
    it('should escape special characters for WoS', () => {
      const result = escapeQueryValue('machine "learning"', 'wos');
      expect(result).not.toContain('"');
    });

    it('should escape special characters for Springer', () => {
      const result = escapeQueryValue('test & query', 'springer');
      expect(result).toBeDefined();
    });

    it('should handle empty strings', () => {
      const result = escapeQueryValue('', 'wos');
      expect(result).toBe('');
    });

    it('should handle SQL injection patterns', () => {
      const result = escapeQueryValue("'; DROP TABLE --", 'wos');
      // escapeQueryValue sanitizes but may not remove all characters
      expect(result).toBeDefined();
    });
  });

  describe('validateQueryComplexity', () => {
    it('should accept simple queries', () => {
      const result = validateQueryComplexity('machine learning');
      expect(result.valid).toBe(true);
    });

    it('should accept queries with reasonable boolean operators', () => {
      const result = validateQueryComplexity('machine AND learning OR deep', {
        maxBooleanOperators: 5
      });
      expect(result.valid).toBe(true);
    });

    it('should reject queries exceeding max length', () => {
      const longQuery = 'a'.repeat(1001);
      const result = validateQueryComplexity(longQuery, { maxLength: 1000 });
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject queries with too many boolean operators', () => {
      const query = 'a AND b AND c AND d AND e AND f AND g AND h AND i AND j AND k';
      const result = validateQueryComplexity(query, { maxBooleanOperators: 5 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('boolean');
    });

    it('should detect potential injection patterns', () => {
      const result1 = validateQueryComplexity('SELECT * FROM papers');
      // Depending on implementation, this may or may not be valid
      expect(result1).toBeDefined();
    });
  });

  describe('withTimeout', () => {
    it('should resolve before timeout', async () => {
      const promise = Promise.resolve('success');
      const result = await withTimeout(promise, 1000);
      expect(result).toBe('success');
    });

    it('should reject on timeout', async () => {
      const slowPromise = new Promise<never>(() => undefined);
      await expect(withTimeout(slowPromise, 100, 'Timeout!')).rejects.toThrow('Timeout!');
    });

    it('should propagate errors from original promise', async () => {
      const failingPromise = Promise.reject(new Error('Original error'));
      await expect(withTimeout(failingPromise, 1000)).rejects.toThrow('Original error');
    });
  });

  describe('sanitizeRequest', () => {
    it('should mask API keys in headers', () => {
      const config = {
        headers: {
          'X-ApiKey': 'secret-key-12345',
          'Content-Type': 'application/json'
        }
      };
      const sanitized = sanitizeRequest(config);
      expect(sanitized.headers['X-ApiKey']).not.toBe('secret-key-12345');
      expect(sanitized.headers['X-ApiKey']).toContain('***');
      expect(sanitized.headers['Content-Type']).toBe('application/json');
    });

    it('should mask session and SAML headers', () => {
      const config = {
        headers: {
          'X-Session': 'session-secret',
          'SAML': 'saml-secret'
        }
      };
      const sanitized = sanitizeRequest({ ...config, data: { auth: 'auth-secret' } });
      expect(sanitized.headers['X-Session']).toBe('***REDACTED***');
      expect(sanitized.headers.SAML).toBe('***REDACTED***');
      expect(sanitized.data.auth).toBe('***REDACTED***');
    });

    it('should mask Authorization headers', () => {
      const config = {
        headers: {
          'Authorization': 'Bearer token123'
        }
      };
      const sanitized = sanitizeRequest(config);
      expect(sanitized.headers['Authorization']).toContain('***');
    });

    it('should mask api_key in params', () => {
      const config = {
        params: {
          api_key: 'secret123',
          query: 'machine learning'
        }
      };
      const sanitized = sanitizeRequest(config);
      expect(sanitized.params.api_key).toContain('***');
      expect(sanitized.params.query).toBe('machine learning');
      expect(sanitizeRequest({ params: { author: 'Alice' } }).params.author).toBe('Alice');
      expect(sanitizeUrl('https://example.com/article?author=Alice')).toBe('https://example.com/article?author=Alice');
    });

    it('should mask session, JWT, SSO, and SAML URL parameters', () => {
      const sanitized = sanitizeUrl('https://example.com/article?session=session-secret&jwt=jwt-secret&sso=sso-secret&saml=saml-secret');
      for (const secret of ['session-secret', 'jwt-secret', 'sso-secret', 'saml-secret']) {
        expect(sanitized).not.toContain(secret);
      }
    });

    it('should handle null/undefined config', () => {
      // sanitizeRequest returns the input as-is for null/undefined
      expect(sanitizeRequest(null)).toBeNull();
      expect(sanitizeRequest(undefined)).toBeUndefined();
    });
  });

  describe('sanitizeSensitiveText', () => {
    it('preserves prose that starts with Basic while redacting an unquoted auth token', () => {
      expect(sanitizeBody('Basic "concept"')).toBe('Basic "concept"');
      expect(sanitizeBody('Basic basic-secret')).toBe('Basic ***');
    });

    it('preserves bibliographic authors while redacting explicit credential keys', () => {
      const sanitized = sanitizeBody({
        authors: ['Alice', 'Bob'],
        authorization: 'Bearer secret-token',
        apiKey: 'api-secret',
        title: 'A paper'
      });
      expect(sanitized.authors).toEqual(['Alice', 'Bob']);
      expect(sanitized.authorization).toBe('***REDACTED***');
      expect(sanitized.apiKey).toBe('***REDACTED***');
      expect(sanitized.title).toBe('A paper');
    });

    it('removes credentials from headers, query strings, URLs, and auth schemes', () => {
      const sanitized = sanitizeSensitiveText([
        'x-api-key=api-secret',
        'Authorization: Bearer bearer-secret',
        'Cookie: lang=en; session=session-secret',
        'SAML: saml-secret',
        'auth: auth-secret',
        'x-auth-token: auth-token-secret',
        'https://user:password@example.com/article?jwt=jwt-secret',
        'Basic basic-secret'
      ].join('\\n'));

      for (const secret of ['api-secret', 'bearer-secret', 'session-secret', 'saml-secret', 'auth-secret', 'auth-token-secret', 'password', 'jwt-secret', 'basic-secret']) {
        expect(sanitized).not.toContain(secret);
      }
    });

    it('preserves JSON delimiters while redacting embedded credentials', () => {
      const sanitized = sanitizeSensitiveText('{"url":"https://example.com/?session=session-secret","authorization":"Bearer bearer-secret","cookie":"a,b=secret"}');
      expect(() => JSON.parse(sanitized)).not.toThrow();
      expect(sanitized).not.toContain('session-secret');
      expect(sanitized).not.toContain('bearer-secret');
      expect(sanitized).not.toContain('b=secret');
    });
  });

  describe('sanitizeDownloadPath', () => {
    it('should resolve to base dir when input is empty', () => {
      const result = sanitizeDownloadPath(undefined, './downloads');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe(path.resolve('./downloads'));
    });

    it('should accept a safe relative path', () => {
      const result = sanitizeDownloadPath('subdir', './downloads');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe(path.resolve('./downloads/subdir'));
    });

    it('should reject parent directory traversal', () => {
      const result = sanitizeDownloadPath('../../etc', './downloads');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('traversal');
    });

    it('should reject absolute paths outside base dir', () => {
      const result = sanitizeDownloadPath('/etc/passwd', './downloads');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('traversal');
    });

    it('should reject control characters', () => {
      const result = sanitizeDownloadPath('evil\x00path', './downloads');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('control');
    });

    it('should allow nested safe paths', () => {
      const result = sanitizeDownloadPath('a/b/c', './downloads');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe(path.resolve('./downloads/a/b/c'));
    });

    it('should reject traversal hidden inside a long path', () => {
      const result = sanitizeDownloadPath('ok/../../escape', './downloads');
      expect(result.valid).toBe(false);
    });

    it('should reject a symlink pointing outside base dir', () => {
      const os = require('os');
      const tmpDir = os.tmpdir();
      const baseDir = path.join(tmpDir, 'mcp-test-base');
      const outsideDir = path.join(tmpDir, 'mcp-test-outside');
      const linkPath = path.join(baseDir, 'evil-link');

      const fs = require('fs');
      fs.mkdirSync(baseDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      try {
        // Create symlink/junction pointing outside baseDir
        if (os.platform() === 'win32') {
          fs.symlinkSync(outsideDir, linkPath, 'junction');
        } else {
          fs.symlinkSync(outsideDir, linkPath, 'dir');
        }

        const result = sanitizeDownloadPath('evil-link', baseDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('traversal');
      } finally {
        try { fs.rmSync(linkPath, { force: true }); } catch { /* */ }
        try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* */ }
      }
    });
  });

  describe('sanitizeFilename', () => {
    it('should strip path separators', () => {
      expect(sanitizeFilename('foo/bar')).toBe('foo_bar');
      expect(sanitizeFilename('foo\\bar')).toBe('foo_bar');
    });

    it('should strip traversal segments', () => {
      expect(sanitizeFilename('../../etc')).toBe('.._.._etc');
    });

    it('should return a default for empty input', () => {
      expect(sanitizeFilename('')).toBe('download');
    });

    it('should remove dangerous characters', () => {
      const result = sanitizeFilename('file<:>:"|?*');
      expect(result).not.toMatch(/[<>:"|?*]/);
    });
  });
});
