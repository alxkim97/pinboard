const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  onInit: (callback) => ipcRenderer.on('pin:init', (_event, note) => callback(note)),
  requestOpenMain: (id) => ipcRenderer.send('pin:request-open-main', id),
  unpin: (id) => ipcRenderer.invoke('pin:close', id),
  moveBy: (dx, dy) => ipcRenderer.send('pin:move-by', dx, dy),
  dragStart: (note) => ipcRenderer.send('pin:drag-start', note),
  dragEnd: () => ipcRenderer.send('pin:drag-end'),
});
