'use strict';
/**
 * Tiny persistent JSON store.
 *
 * Lives in Electron's app.getPath('userData') when running inside Electron,
 * otherwise in KONEQTI_DATA_DIR or ~/.koneqti-leads (so the job/browser
 * modules can run without Electron — e.g. a future cloud executor or tests).
 *
 * What is stored here (and nothing else):
 *   - Supabase auth session (encrypted with OS keychain via safeStorage when available)
 *   - device_id
 *   - app settings (concurrency, auto-launch, paused flag)
 *   - profile METADATA (id, platform, handle, engine, fingerprint seed, proxy,
 *     warmup start, working hours, daily counters)
 * Recipes, API keys and message content are NEVER written here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveDataDir() {
  try {
    if (process.env.KONEQTI_DATA_DIR) return process.env.KONEQTI_DATA_DIR;
    if (process.versions && process.versions.electron) {
      // eslint-disable-next-line global-require
      const electron = require('electron');
      if (electron && typeof electron === 'object' && electron.app) {
        return electron.app.getPath('userData');
      }
    }
  } catch (_) {
    /* fall through */
  }
  return path.join(os.homedir(), '.koneqti-leads');
}

class JsonStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]   directory for the store file
   * @param {string} [opts.name]  file name without extension
   * @param {object} [opts.defaults]
   */
  constructor(opts = {}) {
    this.dir = opts.dir || resolveDataDir();
    this.file = path.join(this.dir, `${opts.name || 'config'}.json`);
    this.defaults = opts.defaults || {};
    this.data = {};
    this.crypto = null; // { encrypt(str)->base64, decrypt(base64)->str }
    this._load();
  }

  _load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.data = raw.trim() ? JSON.parse(raw) : {};
      }
    } catch (err) {
      // Corrupt file: keep a backup and start fresh — never crash.
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch (_) { /* ignore */ }
      this.data = {};
    }
    this.data = { ...deepClone(this.defaults), ...this.data };
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch (_) {
      return false;
    }
  }

  get(key, fallback) {
    const v = getPath(this.data, key);
    return v === undefined ? fallback : v;
  }

  set(key, value) {
    setPath(this.data, key, value);
    this._save();
  }

  delete(key) {
    const parts = String(key).split('.');
    const last = parts.pop();
    const parent = parts.length ? getPath(this.data, parts.join('.')) : this.data;
    if (parent && typeof parent === 'object') delete parent[last];
    this._save();
  }

  /** Optional OS-level encryption for secrets (Electron safeStorage). */
  setCrypto(crypto) {
    this.crypto = crypto || null;
  }

  setSecret(key, value) {
    try {
      if (value === null || value === undefined) return this.delete(key);
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      if (this.crypto) return this.set(key, { enc: true, v: this.crypto.encrypt(str) });
      return this.set(key, { enc: false, v: str });
    } catch (_) {
      return undefined;
    }
  }

  getSecret(key) {
    try {
      const rec = this.get(key);
      if (!rec || typeof rec !== 'object') return null;
      if (rec.enc) return this.crypto ? this.crypto.decrypt(rec.v) : null;
      return rec.v;
    } catch (_) {
      return null;
    }
  }
}

function getPath(obj, key) {
  if (!key) return obj;
  return String(key).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

function setPath(obj, key, value) {
  const parts = String(key).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepClone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

let shared = null;
function getStore() {
  if (!shared) {
    shared = new JsonStore({
      name: 'koneqti-leads',
      defaults: {
        device_id: null,
        settings: { concurrency: 1, autoLaunch: true, pausedAll: false },
        profiles: [],
      },
    });
  }
  return shared;
}

module.exports = { JsonStore, getStore, resolveDataDir };
