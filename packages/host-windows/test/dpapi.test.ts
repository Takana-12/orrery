import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protect, unprotect } from '../src/dpapi.ts';

test('DPAPI: values round-trip and the stored form does not contain the secret', () => {
  for (const secret of ['sk-test-1234567890', '日本語の値 with spaces', 'x'.repeat(5000)]) {
    const cipher = protect(secret);
    assert.notEqual(cipher, secret);
    assert.equal(Buffer.from(cipher, 'base64').includes(Buffer.from(secret.slice(0, 12), 'utf8')), false);
    assert.equal(unprotect(cipher), secret);
  }
  assert.throws(() => unprotect(Buffer.from('not a dpapi blob').toString('base64')));
});
