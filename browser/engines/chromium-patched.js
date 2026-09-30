'use strict';
/**
 * Engine: our patched Chromium launch — the user's LOCAL Google Chrome driven by
 * playwright-core with automation fingerprints reduced. Always available when
 * Chrome (or Chromium) is installed. playwright-core never downloads browsers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { fingerprintFor, parseProxy } = require('../fingerprint');

let cachedPath;

function exists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().split(/\r?\n/)[0].trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

/** Detect a local Chrome/Chromium executable per OS. */
function findChrome() {
  if (cachedPath !== undefined) return cachedPath;
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      candidates.push(path.join(base, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      candidates.push(path.join(base, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } else {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      const w = which(cmd);
      if (w) candidates.push(w);
    }
    candidates.push('/usr/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  cachedPath = candidates.find(exists) || null;
  return cachedPath;
}

function isAvailable() {
  return Boolean(findChrome());
}

/** Init script: mask obvious automation traces (kept minimal — heavy spoofing is itself detectable). */
function initScript(fp) {
  return `(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
    } catch (e) {}
    try {
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency}, configurable: true });
    } catch (e) {}
    try {
      if (!window.chrome) { window.chrome = { runtime: {} }; }
    } catch (e) {}
  })();`;
}

/**
 * @param {object} o
 * @param {object} o.profile
 * @param {string} o.userDataDir
 * @param {boolean} [o.headless]
 * @returns {Promise<{context: import('playwright-core').BrowserContext, engine: string}>}
 */
async function launch({ profile, userDataDir, headless = false }) {
  // eslint-disable-next-line global-require
  const { chromium } = require('playwright-core');
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('Google Chrome was not found on this computer. Please install Chrome (or set CHROME_PATH).');
  }
  const fp = fingerprintFor(profile);
  fs.mkdirSync(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless,
    viewport: fp.viewport,
    screen: fp.screen,
    deviceScaleFactor: fp.deviceScaleFactor,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    proxy: parseProxy(profile.proxy),
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,AutomationControlled',
      `--window-size=${fp.viewport.width},${fp.viewport.height + 85}`,
      `--lang=${fp.locale}`,
    ],
    acceptDownloads: false,
  });
  await context.addInitScript(initScript(fp));
  return { context, engine: 'chromium_patched' };
}

module.exports = { name: 'chromium_patched', launch, isAvailable, findChrome };
