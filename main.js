const {
  app, BrowserWindow, Tray, Menu, screen, globalShortcut, ipcMain, shell, nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const updater = require('./updater');

const BUILT_IN_CLIENT_ID = 'd3gafod7yshltrpi29nt62rroujp34';

const TEST_MODE = process.argv.includes('--test');
const ICON_PATH = path.join(__dirname, 'icon.png');
const UI_PRELOAD = path.join(__dirname, 'ui-preload.js');

const DEFAULTS = {
  useFollowing: true,
  streamers: [],
  ignoreStreamers: [],
  pollSeconds: 45,
  displayMs: 5000,
  notifyOnStartup: false,
  soundEnabled: true,
  soundVolume: 0.6,
  customSound: '',
  position: 'top-center',
  animation: 'bounce',
  animationFrom: 'auto',
  edgeMargin: 14,
  display: 'primary',
};
const POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];

app.setAppUserModelId('com.twitchlivenotifier.app');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let win = null;
let tray = null;
let config = null;
let firstRun = false;

const dataPath = (name) => path.join(app.getPath('userData'), name);
const configPath = () => dataPath('config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config ----------
function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2));
    firstRun = true;
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    console.error('Settings file is not valid JSON:', e.message);
    return { ...DEFAULTS };
  }
}

function saveConfigPatch(patch) {
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* fresh file */ }
  fs.writeFileSync(configPath(), JSON.stringify({ ...onDisk, ...patch }, null, 2));
}

function clientId() {
  return String(config.clientId || BUILT_IN_CLIENT_ID).trim();
}
function hasClientId() {
  const id = clientId();
  return id && !id.startsWith('PASTE_');
}

// ---------- notification window ----------
let windowReady = null;

function createWindow() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  windowReady = new Promise((res) => win.webContents.once('did-finish-load', res));
  win.loadFile(path.join(__dirname, 'notification.html'));
}

function soundPayload() {
  if (!config.soundEnabled) return null;
  let file = null;
  if (config.customSound) {
    const p = path.isAbsolute(config.customSound)
      ? config.customSound
      : path.join(app.getPath('userData'), config.customSound);
    if (fs.existsSync(p)) file = pathToFileURL(p).href;
    else console.error('customSound file not found:', p);
  }
  const volume = Math.min(1, Math.max(0, Number(config.soundVolume) || 0));
  return { volume, file };
}

function targetDisplay() {
  if (config.display && config.display !== 'primary') {
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(config.display));
    if (d) return d;
  }
  return screen.getPrimaryDisplay();
}

function positionWindow() {
  win.setBounds(targetDisplay().workArea);
}

function layoutPayload() {
  return {
    position: config.position,
    from: config.animationFrom,
    style: config.animation,
    margin: config.edgeMargin,
  };
}

// ---------- notification queue ----------
const queue = [];
let showing = false;
let fallbackTimer = null;
let currentItem = null;
let showId = 0;

function notify(item) {
  queue.push(item);
  pump();
}

function systemNotify(title, subtitle) {
  notify({ system: true, name: title, subtitle, avatar: pathToFileURL(ICON_PATH).href });
}

async function pump() {
  if (showing || queue.length === 0) return;
  showing = true;
  const item = queue.shift();
  currentItem = item;
  const thisShow = ++showId;
  await windowReady;
  positionWindow();
  win.setIgnoreMouseEvents(true, { forward: true });
  win.showInactive();
  win.webContents.send('show', {
    ...item,
    id: thisShow,
    displayMs: config.displayMs,
    sound: soundPayload(),
    layout: layoutPayload(),
  });
  fallbackTimer = setTimeout(finish, config.displayMs + 3000);
}

function finish() {
  clearTimeout(fallbackTimer);
  if (!showing) return;
  showing = false;
  win.hide();
  setTimeout(pump, 400);
}

ipcMain.on('done', (_e, id) => {
  if (id === showId) finish();
});

ipcMain.on('hover', (_e, on) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true });
});

ipcMain.on('open', () => {
  if (currentItem && currentItem.login) {
    shell.openExternal(`https://www.twitch.tv/${encodeURIComponent(currentItem.login)}`);
  }
});

// ---------- test mode ----------
const FAKE = [
  { name: 'Shroud', game: 'Counter-Strike 2' },
  { name: 'Pokimane', game: 'Just Chatting' },
  { name: 'xQc', game: 'Grand Theft Auto V' },
  { name: 'Ludwig', game: 'Minecraft' },
];
let fakeIdx = 0;

function testNotification() {
  const f = FAKE[fakeIdx++ % FAKE.length];
  notify({ name: f.name, game: f.game, avatar: null, login: f.name.toLowerCase() });
}

function previewNotification() {
  queue.length = 0;
  showing = false;
  clearTimeout(fallbackTimer);
  testNotification();
}

ipcMain.on('preview', previewNotification);

// ---------- Twitch login (Device Code flow: no client secret needed) ----------
const SCOPE = 'user:read:follows';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const tokenFile = () => dataPath('twitch-login.json');

let userTokens = null;
let authPromise = null;
let authBlocked = false;
let twitchStarted = false;
const profiles = new Map();
const lastSeen = new Map();
let firstPoll = true;

function tokenBody(extra) {
  const body = { client_id: clientId(), ...extra };
  if (config.clientSecret) body.client_secret = config.clientSecret;
  return new URLSearchParams(body);
}

async function runLogin() {
  const dr = await fetch('https://id.twitch.tv/oauth2/device', {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ client_id: clientId(), scopes: SCOPE }),
  });
  const d = await dr.json().catch(() => ({}));
  if (!dr.ok) {
    throw new Error(d.message || `Twitch refused the login request (${dr.status}). Is your app's Client Type set to Public?`);
  }

  shell.openExternal(d.verification_uri);
  systemNotify('Connect your Twitch account', `Click Authorize in your browser. Code: ${d.user_code}`);

  const deadline = Date.now() + d.expires_in * 1000;
  let interval = (d.interval || 5) * 1000;
  let j = null;
  while (Date.now() < deadline) {
    await sleep(interval);
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: FORM,
      body: tokenBody({
        scopes: SCOPE,
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) { j = body; break; }
    const msg = String(body.message || '');
    if (msg.includes('authorization_pending')) continue;
    if (msg.includes('slow_down')) { interval += 5000; continue; }
    throw new Error(msg || 'Login failed');
  }
  if (!j) throw new Error('Login timed out');

  const tokens = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in - 300) * 1000,
  };
  const me = await fetch('https://api.twitch.tv/helix/users', {
    headers: { 'Client-Id': clientId(), Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!me.ok) throw new Error(`Could not read your Twitch account (${me.status})`);
  tokens.user_id = (await me.json()).data[0].id;
  return tokens;
}

async function refreshTokens(t) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: FORM,
    body: tokenBody({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || 'Refresh failed');
  return {
    ...t,
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    expires_at: Date.now() + (j.expires_in - 300) * 1000,
  };
}

function getUserTokens() {
  if (authPromise) return authPromise;
  authPromise = (async () => {
    try {
      if (!userTokens) {
        try { userTokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')); } catch { /* not logged in yet */ }
      }
      if (userTokens && Date.now() >= userTokens.expires_at) {
        try {
          userTokens = await refreshTokens(userTokens);
          fs.writeFileSync(tokenFile(), JSON.stringify(userTokens));
        } catch {
          userTokens = null; // login expired or was revoked: sign in again
        }
      }
      if (!userTokens) {
        userTokens = await runLogin();
        fs.writeFileSync(tokenFile(), JSON.stringify(userTokens));
        systemNotify('Twitch connected', "You'll see a notification when someone you follow goes live.");
      }
      return userTokens;
    } catch (e) {
      authBlocked = true;
      console.error('Twitch login failed:', e.message);
      systemNotify("Couldn't connect to Twitch", 'Right-click the tray icon and choose Reconnect Twitch account.');
      throw e;
    } finally {
      authPromise = null;
    }
  })();
  return authPromise;
}

async function helix(pathAndQuery, retry = true) {
  const { access_token } = await getUserTokens();
  const res = await fetch(`https://api.twitch.tv/helix/${pathAndQuery}`, {
    headers: { 'Client-Id': clientId(), Authorization: `Bearer ${access_token}` },
  });
  if (res.status === 401 && retry && userTokens) {
    userTokens.expires_at = 0;
    return helix(pathAndQuery, false);
  }
  if (!res.ok) throw new Error(`Twitch API ${res.status}`);
  return res.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function loadProfiles(param, values) {
  for (const group of chunk(values, 100)) {
    const qs = group.map((v) => `${param}=${encodeURIComponent(v)}`).join('&');
    const { data } = await helix(`users?${qs}`);
    for (const u of data) profiles.set(u.login.toLowerCase(), u);
  }
}


async function fetchFollowedLive() {
  const { user_id } = await getUserTokens();
  const out = [];
  let cursor = null;
  do {
    const q = `streams/followed?user_id=${user_id}&first=100${cursor ? `&after=${cursor}` : ''}`;
    const json = await helix(q);
    out.push(...json.data);
    cursor = json.pagination?.cursor || null;
  } while (cursor);
  return out;
}

// Only the streamers listed in the settings file (when useFollowing is false).
async function fetchListedLive() {
  const logins = config.streamers.map((s) => s.toLowerCase());
  const out = [];
  if (!logins.length) return out;
  for (const group of chunk(logins, 100)) {
    const qs = group.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    out.push(...(await helix(`streams?first=100&${qs}`)).data);
  }
  return out;
}

async function poll() {
  if (authBlocked) return;
  const now = Date.now();
  try {
    const streams = config.useFollowing ? await fetchFollowedLive() : await fetchListedLive();
    const ignore = new Set((config.ignoreStreamers || []).map((s) => s.toLowerCase()));
    const fresh = [];

    for (const s of streams) {
      const login = s.user_login.toLowerCase();
      if (ignore.has(login)) continue;
      const wasLive = lastSeen.has(login) && now - lastSeen.get(login) < 10 * 60 * 1000;
      lastSeen.set(login, now);
      if (!wasLive && (!firstPoll || config.notifyOnStartup)) fresh.push(s);
    }

    const missing = fresh.filter((s) => !profiles.has(s.user_login.toLowerCase())).map((s) => s.user_id);
    if (missing.length) await loadProfiles('id', missing).catch(() => {});

    for (const s of fresh) {
      const p = profiles.get(s.user_login.toLowerCase());
      notify({
        name: s.user_name || p?.display_name || s.user_login,
        game: s.game_name || '',
        title: s.title || '',
        avatar: p?.profile_image_url || null,
        login: s.user_login,
      });
    }
    firstPoll = false;
  } catch (e) {
    console.error('Poll failed:', e.message);
  }
}

function reconnectTwitch() {
  try { fs.unlinkSync(tokenFile()); } catch { /* nothing saved */ }
  userTokens = null;
  authBlocked = false;
  firstPoll = true;
  if (twitchStarted) poll();
}

async function startTwitch() {
  if (twitchStarted) return;
  if (!hasClientId()) {
    console.error('No Twitch Client ID set. Paste yours into BUILT_IN_CLIENT_ID in main.js.');
    systemNotify('Twitch is not set up', 'This build has no Client ID yet.');
    return;
  }
  twitchStarted = true;
  await poll();
  setInterval(poll, Math.max(15, config.pollSeconds) * 1000);
}

// ---------- settings + welcome windows ----------
let settingsWin = null;
let welcomeWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 840,
    minWidth: 500,
    minHeight: 560,
    title: 'Twitch Live Notifier',
    icon: ICON_PATH,
    backgroundColor: '#15151c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: UI_PRELOAD },
  });
  settingsWin.setMenu(null);
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

function openWelcome(first) {
  if (welcomeWin && !welcomeWin.isDestroyed()) {
    welcomeWin.show();
    welcomeWin.focus();
    return;
  }
  welcomeWin = new BrowserWindow({
    width: 540,
    height: 680,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Welcome',
    icon: ICON_PATH,
    backgroundColor: '#15151c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: UI_PRELOAD },
  });
  welcomeWin.setMenu(null);
  welcomeWin.once('ready-to-show', () => welcomeWin.show());
  welcomeWin.on('closed', () => { if (first) startTwitch(); });
  welcomeWin.loadFile(path.join(__dirname, 'welcome.html'), { query: { first: first ? '1' : '0' } });
}

ipcMain.on('welcome:done', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

const SETTING_RULES = {
  position: (v) => POSITIONS.includes(v),
  animation: (v) => ['bounce', 'slide', 'pop', 'fade'].includes(v),
  animationFrom: (v) => ['auto', 'top', 'bottom', 'left', 'right'].includes(v),
  edgeMargin: (v) => Number.isFinite(v) && v >= 0 && v <= 200,
  display: (v) => typeof v === 'string',
  displayMs: (v) => Number.isFinite(v) && v >= 1500 && v <= 30000,
  soundEnabled: (v) => typeof v === 'boolean',
  soundVolume: (v) => Number.isFinite(v) && v >= 0 && v <= 1,
  ignoreStreamers: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  useFollowing: (v) => typeof v === 'boolean',
  streamers: (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && /^[a-z0-9_]{1,25}$/i.test(x)),
};

ipcMain.handle('settings:get', () => {
  const primary = screen.getPrimaryDisplay().id;
  return {
    config: {
      position: config.position,
      animation: config.animation,
      animationFrom: config.animationFrom,
      edgeMargin: config.edgeMargin,
      display: config.display,
      displayMs: config.displayMs,
      soundEnabled: !!config.soundEnabled,
      soundVolume: config.soundVolume,
      ignoreStreamers: config.ignoreStreamers || [],
      useFollowing: config.useFollowing !== false,
      streamers: config.streamers || [],
    },
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    displays: screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: `Display ${i + 1}${d.id === primary ? ' (main)' : ''}, ${d.size.width}x${d.size.height}`,
    })),
  };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const toSave = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'launchAtLogin') {
      app.setLoginItemSettings({ openAtLogin: !!value });
    } else if (SETTING_RULES[key] && SETTING_RULES[key](value)) {
      config[key] = value;
      toSave[key] = value;
    }
  }
  if (Object.keys(toSave).length) saveConfigPatch(toSave);
  if (('useFollowing' in toSave || 'streamers' in toSave) && twitchStarted) poll();
  return true;
});

// ---------- tray ----------
function updateMenuItem() {
  const u = updater.getState();
  if (u.status === 'ready') return { label: `Restart to update to v${u.version}`, click: updater.installNow };
  if (u.status === 'downloading') return { label: `Downloading update v${u.version}...`, enabled: false };
  if (u.status === 'checking') return { label: 'Checking for updates...', enabled: false };
  return { label: 'Check for updates', click: updater.check, enabled: app.isPackaged };
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings...', click: openSettings },
      { label: 'Show test notification  (Ctrl+Shift+T)', click: previewNotification },
      { type: 'separator' },
      { label: 'How it works', click: () => openWelcome(false) },
      { label: 'Reconnect Twitch account', click: reconnectTwitch },
      { label: 'Open config file', click: () => shell.openPath(configPath()) },
      { type: 'separator' },
      { label: `Version ${app.getVersion()}`, enabled: false },
      updateMenuItem(),
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32 }));
  tray.setToolTip('Twitch Live Notifier');
  refreshTrayMenu();
  tray.on('double-click', openSettings);
}

// ---------- boot ----------
app.on('second-instance', () => {
  if (config) openSettings();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  config = loadConfig();
  createWindow();
  createTray();
  if (!TEST_MODE) updater.init(refreshTrayMenu);
  globalShortcut.register('CommandOrControl+Shift+T', previewNotification);

  if (TEST_MODE) {
    testNotification();
    setInterval(testNotification, config.displayMs + 1800);
    return;
  }

  if (firstRun) {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    openWelcome(true);
  } else {
    startTwitch();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => globalShortcut.unregisterAll());