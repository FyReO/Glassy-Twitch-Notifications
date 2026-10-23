const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  preview: () => ipcRenderer.send('preview'),
  welcomeDone: () => ipcRenderer.send('welcome:done'),
});
