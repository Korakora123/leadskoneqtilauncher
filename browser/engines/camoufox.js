'use strict';
/**
 * Engine: Camoufox (stealth Firefox) via camoufox-js.
 * Optional dependency: `npm install camoufox-js && npx camoufox-js fetch`.
 * Falls back to chromium_patched with a logged note when unavailable.
 */
const fs = require('fs');
const { fingerprintFor, parseProxy } = require('../fingerprint');
const { moduleInstalled, importOptional } = require('./optional-module');
const chromiumPatched = require('./chromium-patched');

function isAvailable() {
  return moduleInstalled('camoufox-js');
}

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

async function launch({ profile, userDataDir, headless = false, log }) {
  const mod = await importOptional('camoufox-js');
  const Camoufox = mod && (mod.Camoufox || (mod.default && mod.default.Camoufox));
  if (!Camoufox) {
    if (log) log.warn('camoufox-js not installed — falling back to chromium_patched', { profile_id: profile.id });
    const r = await chromiumPatched.launch({ profile, userDataDir, headless, log });
    return { ...r, fallback_from: 'camoufox' };
  }
  try {
    const fp = fingerprintFor(profile);
    fs.mkdirSync(userDataDir, { recursive: true });
    const context = await Camoufox({
      user_data_dir: userDataDir, // → returns a persistent BrowserContext
      headless,
      os: osName(),
      proxy: parseProxy(profile.proxy),
      window: [fp.viewport.width, fp.viewport.height],
      locale: fp.locale,
      humanize: true,
    });
    return { context, engine: 'camoufox' };
  } catch (err) {
    if (log) log.warn('camoufox launch failed — falling back to chromium_patched', { profile_id: profile.id, err: err.message });
    const r = await chromiumPatched.launch({ profile, userDataDir, headless, log });
    return { ...r, fallback_from: 'camoufox' };
  }
}

module.exports = { name: 'camoufox', launch, isAvailable };
