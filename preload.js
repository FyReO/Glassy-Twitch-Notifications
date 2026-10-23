const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notifier', {
  onShow: (cb) => ipcRenderer.on('show', (_e, data) => cb(data)),
  done: (id) => ipcRenderer.send('done', id),
  hover: (on) => ipcRenderer.send('hover', !!on),
  open: () => ipcRenderer.send('open'),
});
