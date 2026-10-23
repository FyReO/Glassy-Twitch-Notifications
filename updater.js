const { app } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let autoUpdater = null;
let state = { status: 'idle', version: null };
let onChange = () => {};

function init(changeCallback) {
  onChange = changeCallback || onChange;
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('electron-updater not available:', e.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i.version }));
  autoUpdater.on('update-not-available', () => set({ status: 'uptodate' }));
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => {
    console.error('Update error:', e && e.message);
    set({ status: 'error' });
  });

  check();
  setInterval(check, CHECK_EVERY_MS);
}

function set(patch) {
  state = { ...state, ...patch };
  onChange(state);
}

function check() {
  if (!autoUpdater || state.status === 'ready' || state.status === 'downloading') return;
  autoUpdater.checkForUpdates().catch(() => {});
}

function installNow() {
  if (autoUpdater && state.status === 'ready') autoUpdater.quitAndInstall(false, true);
}

module.exports = { init, check, installNow, getState: () => state };
