'use strict';
/**
 * Koneqti Leads launcher — Electron entry point.
 *
 * Runs silently in the system tray. After login it connects to the brain over
 * WebSocket, receives browser jobs (scraping / outreach / proof screenshots) and
 * executes them with the user's local Chrome and residential IP.
 * NO intelligence is stored here: recipes arrive per job and are discarded.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, shell, safeStorage, nativeImage, dialog } = require('electron');

// ---------- config (.env: userData first, then app dir; never overrides real env) ----------
function loadEnv() {
  try {
    // eslint-disable-next-line global-require
    const dotenv = require('dotenv');
    const candidates = [
      path.join(app.getPath('userData'), '.env'),
      process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
      path.join(__dirname, '.env'),
    ].filter(Boolean);
    for (const file of candidates) {
      if (fs.existsSync(file)) dotenv.config({ path: file, override: false });
    }
  } catch (_) { /* optional */ }
}
loadEnv();

const { getStore } = require('./store');
const { ProfileManager, PLATFORMS, ENGINES } = require('./profile-manager');
const { Auth } = require('./auth');
const { BrainClient } = require('./websocket-client');
const { JobRunner } = require('./playwright-runner');
const { createUploader, createDownloader } = require('./uploader');
const { availableEngines } = require('./browser/adapter');
const { createTray } = require('./tray');
const { createLogger } = require('./logger');

const log = createLogger('main');

const CONFIG = {
  brainWsUrl: process.env.BRAIN_WS_URL || '',
  brainHttpUrl: process.env.BRAIN_HTTP_URL || '',
  electronSecret: process.env.ELECTRON_SECRET || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  dashboardUrl: process.env.DASHBOARD_URL || 'https://leads.koneqti.com',
};

const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

let store;
let pm;
let auth;
let brain;
let runner;
let tray;
let win = null;
let isQuitting = false;
let loggedIn = false;
let userEmail = null;

process.on('uncaughtException', (err) => log.error('uncaught exception', { err: err && err.message }));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: err && err.message }));

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init).catch((err) => log.error('init failed', { err: err.message }));
}

app.on('window-all-closed', () => { /* stay in tray */ });
app.on('activate', () => showWindow());
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', (e) => {
  if (runner && !runner._shutdownDone) {
    e.preventDefault();
    runner._shutdownDone = true;
    Promise.resolve()
      .then(() => runner.shutdown())
      .catch(() => {})
      .finally(() => {
        try { if (brain) brain.stop(); } catch (_) { /* ignore */ }
        setTimeout(() => app.exit(0), 300);
      });
  }
});

async function init() {
  store = getStore();
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      store.setCrypto({
        encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
        decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
      });
    }
  } catch (_) { /* fall back to plain store (file mode 0600) */ }

  if (!store.get('device_id')) store.set('device_id', crypto.randomUUID());
  const settings = store.get('settings', {});

  pm = new ProfileManager({ store });
  auth = new Auth({ store, supabaseUrl: CONFIG.supabaseUrl, anonKey: CONFIG.supabaseAnonKey });
  const getAccessToken = () => auth.getAccessToken();
  const upload = createUploader({ brainHttpUrl: CONFIG.brainHttpUrl, electronSecret: CONFIG.electronSecret, getAccessToken });
  const download = createDownloader({ brainHttpUrl: CONFIG.brainHttpUrl, electronSecret: CONFIG.electronSecret, getAccessToken });

  brain = new BrainClient({
    url: CONFIG.brainWsUrl,
    secret: CONFIG.electronSecret,
    auth,
    deviceId: store.get('device_id'),
    appVersion: app.getVersion(),
    profileManager: pm,
    engines: availableEngines,
  });
  runner = new JobRunner({
    profileManager: pm,
    send: (type, payload) => brain.send(type, payload),
    requestSelector: (req) => brain.requestSelector(req),
    upload: (files, meta) => upload({ files, ...meta }),
    download,
    concurrency: Number(process.env.JOB_CONCURRENCY) || settings.concurrency || 1,
    headless: process.env.KONEQTI_HEADLESS === '1' ? true : undefined,
  });
  brain.setRunner(runner);
  runner.setPausedAll(Boolean(settings.pausedAll));

  brain.on('status', broadcastStatus);
  runner.on('status', broadcastStatus);
  runner.on('profiles_changed', broadcastStatus);

  applyAutoLaunch(settings.autoLaunch !== false);

  tray = createTray({
    iconPath: ICON_PATH,
    onOpenDashboard: () => openDashboard(''),
    onOpenProfiles: () => showWindow(),
    onTogglePause: (paused) => setSettings({ pausedAll: paused }),
    onQuit: () => { isQuitting = true; app.quit(); },
  });

  registerIpc();

  const user = await auth.getUser();
  loggedIn = Boolean(user);
  userEmail = user ? user.email : null;
  if (loggedIn) {
    brain.start();
    // Started at login → stay in tray; otherwise show the window.
    const openedAtLogin = app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin;
    if (!openedAtLogin && !process.argv.includes('--hidden')) showWindow();
  } else {
    showWindow();
  }
  broadcastStatus();
}

function applyAutoLaunch(enabled) {
  try {
    if (process.platform === 'linux') return; // not supported by Electron on Linux
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true, args: ['--hidden'] });
  } catch (err) {
    log.warn('auto-launch setting failed', { err: err.message });
  }
}

// ---------- window ----------
function createWindow() {
  const w = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Koneqti Leads',
    backgroundColor: '#0A0A0F',
    icon: nativeImage.createFromPath(ICON_PATH),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  w.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      w.hide(); // hide to tray
    }
  });
  w.on('closed', () => { win = null; });
  w.once('ready-to-show', () => w.show());
  return w;
}

function loadPage(w) {
  const page = loggedIn ? 'profiles.html' : 'login.html';
  const current = w.webContents.getURL();
  if (!current.endsWith(`/renderer/${page}`)) {
    w.loadFile(path.join(__dirname, 'renderer', page)).catch((err) => log.error('load page failed', { err: err.message }));
  }
}

function showWindow() {
  try {
    if (!app.isReady()) return;
    if (!win) win = createWindow();
    loadPage(win);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (err) {
    log.error('showWindow failed', { err: err.message });
  }
}

function openDashboard(sub) {
  const base = CONFIG.dashboardUrl.replace(/\/+$/, '');
  const suffix = typeof sub === 'string' && /^\/?[\w\-/]*$/.test(sub) ? `/${sub.replace(/^\/+/, '')}` : '';
  shell.openExternal(`${base}${suffix || '/dashboard'}`).catch(() => {});
}

// ---------- status ----------
function buildStatus() {
  const settings = store ? store.get('settings', {}) : {};
  const engines = availableEngines();
  return {
    logged_in: loggedIn,
    email: userEmail,
    configured: Boolean(CONFIG.brainWsUrl && CONFIG.supabaseUrl && CONFIG.supabaseAnonKey),
    brain: brain ? brain.status() : { state: 'idle', connected: false },
    runner: runner ? runner.status() : { running: 0, queued: 0 },
    paused_all: Boolean(settings.pausedAll),
    engines,
    chrome_found: engines.includes('chromium_patched'),
    settings: {
      autoLaunch: settings.autoLaunch !== false,
      concurrency: runner ? runner.concurrency : settings.concurrency || 1,
      pausedAll: Boolean(settings.pausedAll),
    },
    profiles: pm ? pm.forUi() : [],
    app_version: app.getVersion(),
    dashboard_url: CONFIG.dashboardUrl,
  };
}

let statusTimer = null;
function broadcastStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    try {
      const s = buildStatus();
      if (tray) tray.update(s);
      if (win && !win.isDestroyed()) win.webContents.send('status', s);
    } catch (err) {
      log.warn('broadcast failed', { err: err.message });
    }
  }, 100);
}

function setSettings(patch) {
  const cur = store.get('settings', {});
  const next = { ...cur };
  if (patch && 'autoLaunch' in patch) {
    next.autoLaunch = Boolean(patch.autoLaunch);
    applyAutoLaunch(next.autoLaunch);
  }
  if (patch && 'concurrency' in patch) {
    next.concurrency = Math.max(1, Math.min(2, Number(patch.concurrency) || 1));
    runner.setConcurrency(next.concurrency);
  }
  if (patch && 'pausedAll' in patch) {
    next.pausedAll = Boolean(patch.pausedAll);
    runner.setPausedAll(next.pausedAll);
  }
  store.set('settings', next);
  broadcastStatus();
  return next;
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      const data = await fn(arg);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'error' };
    }
  });
}

function registerIpc() {
  handle('auth:login', async ({ email, password } = {}) => {
    const r = await auth.login(email, password);
    if (!r.ok) throw new Error(r.error);
    loggedIn = true;
    userEmail = r.user.email;
    brain.reconnectNow();
    if (win) loadPage(win);
    broadcastStatus();
    return { email: r.user.email };
  });

  handle('auth:logout', async () => {
    brain.stop();
    await auth.logout();
    loggedIn = false;
    userEmail = null;
    if (win) loadPage(win);
    broadcastStatus();
    return true;
  });

  handle('status:get', async () => buildStatus());

  handle('profiles:list', async () => pm.forUi());

  handle('profiles:add', async (p = {}) => {
    if (!PLATFORMS.includes(p.platform) || p.platform === 'web') throw new Error('Choose a platform');
    if (p.engine && !ENGINES.includes(p.engine)) throw new Error('Unknown engine');
    const created = pm.add({ platform: p.platform, handle: p.handle, engine: p.engine || 'chromium_patched', proxy: p.proxy || null });
    brain.sendProfiles();
    broadcastStatus();
    return { id: created.id };
  });

  handle('profiles:openBrowser', async (id) => {
    const r = await runner.openProfileBrowser(String(id));
    broadcastStatus();
    return r;
  });

  handle('profiles:remove', async (id) => {
    if (win) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Remove', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Remove this profile?',
        detail: 'Its saved browser login (cookies) on this computer will be deleted.',
      });
      if (response !== 0) return false;
    }
    await pm.remove(String(id));
    brain.sendProfiles();
    broadcastStatus();
    return true;
  });

  handle('profiles:setWorkingHours', async ({ id, hours } = {}) => {
    pm.setWorkingHours(String(id), hours || {});
    brain.sendProfiles();
    broadcastStatus();
    return true;
  });

  handle('settings:get', async () => buildStatus().settings);
  handle('settings:set', async (patch) => setSettings(patch || {}));
  handle('app:openDashboard', async (sub) => { openDashboard(sub); return true; });
}
