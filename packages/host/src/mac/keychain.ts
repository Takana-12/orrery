// Secrets on macOS: values are sealed (AES-256-GCM, ../sealed.ts) with a random key that lives in the person's
// login keychain. This is the counterpart of Windows DPAPI: only this user of this machine can open them, and
// Orrery's own files hold ciphertext only.
// The key is read and written through /usr/bin/security rather than the keychain API directly. That is deliberate:
// a keychain item trusts the program that made it, and Orrery is rebuilt (so, to macOS, a different program) on
// every update, which would bring up "Orrery wants to use your keychain" each time. /usr/bin/security never changes.
// The key is read once, when a secret is first needed, and kept in memory.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, seal } from '../sealed.ts';

const SECURITY = '/usr/bin/security';
const ACCOUNT = 'env-master-key';
/** Tests use an item of their own, so they never touch the real key. */
const service = (): string => process.env.ORRERY_KEYCHAIN_SERVICE || 'Orrery';
const ITEM_NOT_FOUND = 44;

let key: Buffer | null = null;

function readKey(): Buffer | null {
  try {
    const out = execFileSync(SECURITY, ['find-generic-password', '-s', service(), '-a', ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
    if (!/^[0-9a-f]{64}$/.test(out)) throw new Error('キーチェーンの鍵の形式が正しくありません');
    return Buffer.from(out, 'hex');
  } catch (e) {
    if ((e as { status?: number }).status === ITEM_NOT_FOUND) return null;
    // Locked, denied, unreadable: never answer "there is none" (a new key would orphan every stored value).
    throw new Error(`キーチェーンから鍵を読めませんでした: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim()}`);
  }
}

function createKey(): Buffer {
  const fresh = randomBytes(32);
  // Through security's own prompt (stdin), not its arguments: other users of the machine can see arguments.
  // No -U: if an item appeared in the meantime, adding fails and the read below returns that one instead.
  try {
    execFileSync(SECURITY, ['-i'], { input: `add-generic-password -s "${service()}" -a "${ACCOUNT}" -l "Orrery env key" -w ${fresh.toString('hex')}\n`, stdio: ['pipe', 'ignore', 'ignore'], timeout: 30_000 });
  } catch {}
  const stored = readKey();
  if (!stored) throw new Error('キーチェーンに鍵を保存できませんでした');
  return stored;
}

const theKey = (): Buffer => (key ??= readKey() ?? createKey());

export const protect = (plain: string): string => seal(theKey(), plain);
export const unprotect = (cipherBase64: string): string => open(theKey(), cipherBase64);

/** Tests: remove the item and forget the key. */
export function forgetKey(): void {
  key = null;
  try {
    execFileSync(SECURITY, ['delete-generic-password', '-s', service(), '-a', ACCOUNT], { stdio: 'ignore', timeout: 30_000 });
  } catch {}
}
