const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pinAPI', {
  list: () => ipcRenderer.invoke('pin:list'),
  open: (note) => ipcRenderer.invoke('pin:open', note),
  close: (id) => ipcRenderer.invoke('pin:close', id),
  refresh: (note) => ipcRenderer.invoke('pin:refresh', note),
  onOpenDetail: (callback) => ipcRenderer.on('pin:open-detail', (_event, noteId) => callback(noteId)),
  onUnpinned: (callback) => ipcRenderer.on('pin:unpinned', (_event, noteId) => callback(noteId)),
});
