const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the notification pill.
contextBridge.exposeInMainWorld('notifier', {
  onShow: (cb) => ipcRenderer.on('show', (_e, data) => cb(data)),
  done: (id) => ipcRenderer.send('done', id),
  hover: (on) => ipcRenderer.send('hover', !!on),
  open: () => ipcRenderer.send('open'),
  onHoverState: (cb) => ipcRenderer.on('hover-state', (_e, on) => cb(!!on)),
});