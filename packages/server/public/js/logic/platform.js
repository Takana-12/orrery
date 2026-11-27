// Which desktop the page is shown on, and the few words and keys that differ between them.
// The page and the server are always on the same machine, so the browser's own answer is the server's too.
// Everything OS-dependent the page says comes from here: no other module looks at the platform.
const name = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';

export const isMac = /mac/i.test(name);
/** The key held with Enter to send, V to paste: ⌘ on a Mac (Ctrl works there too), Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl';
export const SEND_KEYS = `${MOD}+Enter`;
/** Where the app stays while its window is closed. */
export const TRAY = isMac ? 'メニューバー' : '通知領域';
/** How the values of environment variables are kept (packages/host: DPAPI on Windows, a keychain-held key on macOS). */
export const SECRET_STORE = isMac ? 'この Mac のキーチェーンに置いた鍵による暗号化（AES-256-GCM）' : 'Windowsのユーザー単位の暗号化（DPAPI）';
/** True for the "send" chord: Enter with Ctrl, or with ⌘. */
export const isSendChord = (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);
