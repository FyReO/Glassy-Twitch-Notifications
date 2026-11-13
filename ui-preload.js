const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  preview: () => ipcRenderer.send('preview'),
  lookup: (name) => ipcRenderer.invoke('streamers:lookup', name),
  live: () => ipcRenderer.invoke('settings:live'),
  welcomeDone: () => ipcRenderer.send('welcome:done'),
});