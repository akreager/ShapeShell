'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The Manage Extensions window. Named verbs only, and every one takes an install key rather
// than a path or URL: the main process looks up anything it acts on itself.
contextBridge.exposeInMainWorld('manageApi', {
  catalog: () => ipcRenderer.invoke('manage:catalog'),
  onCatalog: (cb) => ipcRenderer.on('manage:catalog', (_event, rows) => cb(rows)),
  install: (key) => ipcRenderer.send('manage:install', key),
  cancel: (key) => ipcRenderer.send('manage:cancel', key),
  pin: (key, pinned) => ipcRenderer.send('manage:pin', key, pinned),
  openSource: (key) => ipcRenderer.send('manage:open-source', key),
  remove: (key) => ipcRenderer.invoke('manage:remove', key),
  // Only after the page's unsupported-extension warning has been accepted.
  installUnsupported: (folder) => ipcRenderer.invoke('manage:install-unsupported', folder),
  close: () => ipcRenderer.send('manage:close'),
});
