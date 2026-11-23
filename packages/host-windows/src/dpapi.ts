// Windows DPAPI (CryptProtectData, current-user scope) through FFI.
// Secret values are encrypted with a key Windows derives from the user's logon; only the same Windows user
// on the same machine can decrypt them. The control room stores ciphertext only.
import koffi from 'koffi';

const crypt32 = koffi.load('crypt32.dll');
const kernel32 = koffi.load('kernel32.dll');
const DATA_BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void*' });
const CryptProtectData = crypt32.func('bool __stdcall CryptProtectData(DATA_BLOB* dataIn, void* descr, void* entropy, void* reserved, void* prompt, uint32 flags, _Out_ DATA_BLOB* dataOut)');
const CryptUnprotectData = crypt32.func('bool __stdcall CryptUnprotectData(DATA_BLOB* dataIn, void* descr, void* entropy, void* reserved, void* prompt, uint32 flags, _Out_ DATA_BLOB* dataOut)');
const LocalFree = kernel32.func('void* __stdcall LocalFree(void* p)');
const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

function transform(fn: typeof CryptProtectData, input: Buffer): Buffer {
  const out: { cbData: number; pbData: unknown } = { cbData: 0, pbData: null };
  // An empty buffer has no address; DPAPI is fine with one zero byte and we record the real length ourselves.
  if (!fn({ cbData: input.length, pbData: input.length ? input : Buffer.alloc(1) }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)) {
    throw new Error('DPAPI call failed');
  }
  try {
    return Buffer.from(koffi.decode(out.pbData, koffi.array('uint8', out.cbData, 'Typed')) as Uint8Array);
  } finally {
    LocalFree(out.pbData);
  }
}

/** Encrypt for the current Windows user. Returns base64 ciphertext. */
export function protect(plain: string): string {
  return transform(CryptProtectData, Buffer.from(plain, 'utf8')).toString('base64');
}

/** Decrypt something `protect` produced for this user on this machine. */
export function unprotect(cipherBase64: string): string {
  return transform(CryptUnprotectData, Buffer.from(cipherBase64, 'base64')).toString('utf8');
}
