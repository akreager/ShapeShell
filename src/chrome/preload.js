'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Named verbs only — no channel name crosses the bridge, so neither chrome page can
// reach arbitrary IPC. Window min/max/close are deliberately absent: those buttons are
// drawn natively by the Window Controls Overlay.

// Toolbar view.
contextBridge.exposeInMainWorld('shellApi', {
  openMenu: (x, y) => ipcRenderer.send('shell:open-menu', { x, y }),
  onState: (cb) => ipcRenderer.on('shell:state', (_event, state) => cb(state)),
});

// Popover view.
contextBridge.exposeInMainWorld('menuApi', {
  action: (verb) => ipcRenderer.send('menu:action', verb),
  close: () => ipcRenderer.send('menu:close'),
  onOpen: (cb) => ipcRenderer.on('menu:open', (_event, state) => cb(state)),
});
