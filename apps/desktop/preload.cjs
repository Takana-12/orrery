// The one thing the page may tell the window: which theme it shows, so Windows draws the title bar
// (minimise / maximise / close) in the same light or dark. Nothing else crosses this bridge.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orreryShell', {
  /** @param {'auto' | 'light' | 'dark'} t */
  theme: (t) => ipcRenderer.send('orrery:theme', t),
});
