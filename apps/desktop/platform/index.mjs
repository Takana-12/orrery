// The desktop shell's port to the operating system: what differs between the Windows app and the macOS app
// (where the built app lives, the tray, the menu, starting at sign-in, restarting after an update) sits behind
// one shape, filled in by windows.mjs and mac.mjs. main.mjs, updater.mjs, package.mjs and install.mjs only call
// `platform.*` and never ask which OS they are on (packages/host/test/platform-guard.test.ts enforces it, and
// apps/desktop/platform.test.mjs checks that both files export the same shape).
// Neither file imports Electron: what needs it is handed in, so package.mjs can use them under plain Node too.
// Design notes: docs/08-対応OSと移植層.md.
export const platform = process.platform === 'win32' ? await import('./windows.mjs') : await import('./mac.mjs');
