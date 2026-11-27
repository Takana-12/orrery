// Authenticated encryption with a 256-bit key (AES-256-GCM). Used where the OS has no "encrypt for this user" call
// of its own and only keeps a key for us (macOS: the key lives in the login keychain, see mac/keychain.ts).
// Stored form: base64( 12-byte nonce | 16-byte tag | ciphertext ). A changed or foreign value fails to open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE = 12;
const TAG = 16;

export function seal(key: Buffer, plain: string): string {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), body]).toString('base64');
}

export function open(key: Buffer, sealedBase64: string): string {
  const raw = Buffer.from(sealedBase64, 'base64');
  if (raw.length < NONCE + TAG) throw new Error('not a sealed value');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE));
  d.setAuthTag(raw.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([d.update(raw.subarray(NONCE + TAG)), d.final()]).toString('utf8');
}
