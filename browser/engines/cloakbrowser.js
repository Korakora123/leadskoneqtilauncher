'use strict';
/**
 * Engine: CloakBrowser (stealth Chromium with source-level fingerprint patches).
 * Optional dependency: `npm install cloakbrowser`. If it is not installed or fails
 * to launch, we fall back to chromium_patched and log a note.
 */
const fs = require('fs');
const { fingerprintFor, parseProxy } = require('../fingerprint');
const { moduleInstalled, importOptional } = require('./optional-module');
const chromiumPatched = require('./chromium-patched');

function isAvailable() {
  return moduleInstalled('cloakbrowser');
}

async function launch({ profile, userDataDir, headless = false, log }) {
  const mod = await importOptional('cloakbrowser');
  const fn = mod && (mod.launchPersistentContext || (mod.default && mod.default.launchPersistentContext));
  if (!fn) {
    if (log) log.warn('cloakbrowser not installed — falling back to chromium_patched', { profile_id: profile.id });
    const r = await chromiumPatched.launch({ profile, userDataDir, headless, log });
    return { ...r, fallback_from: 'cloakbrowser' };
  }
  try {
    const fp = fingerprintFor(profile);
    fs.mkdirSync(userDataDir, { recursive: true });
    const context = await fn({
      userDataDir,
      headless,
      proxy: parseProxy(profile.proxy),
      viewport: fp.viewport,
      locale: fp.locale,
      timezone: fp.timezoneId,
      // Stable fingerprint for this profile's whole life.
      args: [`--fingerprint=${fp.numericSeed}`],
      humanize: true,
    });
    return { context, engine: 'cloakbrowser' };
  } catch (err) {
    if (log) log.warn('cloakbrowser launch failed — falling back to chromium_patched', { profile_id: profile.id, err: err.message });
    const r = await chromiumPatched.launch({ profile, userDataDir, headless, log });
    return { ...r, fallback_from: 'cloakbrowser' };
  }
}

module.exports = { name: 'cloakbrowser', launch, isAvailable };
