// What the page may tell the window, and nothing else crosses this bridge:
//   theme    which theme it shows, so Windows draws the title bar (minimise / maximise / close) in the same light or dark
//   opacity  how solid the window is (chosen in settings), 0.4 .. 1
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orreryShell', {
  /** @param {'auto' | 'light' | 'dark'} t */
  theme: (t) => ipcRenderer.send('orrery:theme', t),
  /** @param {number} v */
  opacity: (v) => ipcRenderer.send('orrery:opacity', v),
});
