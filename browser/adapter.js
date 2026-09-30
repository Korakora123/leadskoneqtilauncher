'use strict';
/**
 * BrowserAdapter — the ONLY way jobs get a browser. Jobs never call an engine
 * directly, so the engine can be swapped (brain decides per platform) without
 * touching job code.
 *
 *   const b = new BrowserAdapter('cloakbrowser', { profileManager });
 *   await b.launch(profile);
 *   const page = await b.newPage();
 *   ...
 *   await b.close();
 *
 * No Electron imports — reusable by a future cloud executor.
 */
const { createLogger } = require('../logger');

const ENGINES = {
  cloakbrowser: () => require('./engines/cloakbrowser'),
  camoufox: () => require('./engines/camoufox'),
  chromium_patched: () => require('./engines/chromium-patched'),
};

/** Engines usable on this machine (sent to brain in `hello`). */
function availableEngines() {
  const out = [];
  for (const [name, load] of Object.entries(ENGINES)) {
    try {
      if (load().isAvailable()) out.push(name);
    } catch (_) { /* ignore */ }
  }
  return out;
}

class BrowserAdapter {
  /**
   * @param {'cloakbrowser'|'camoufox'|'chromium_patched'} engine
   * @param {object} [opts]
   * @param {{userDataDir:(p:object)=>string}} [opts.profileManager]
   * @param {string} [opts.userDataDir]  explicit dir (overrides profileManager)
   * @param {boolean} [opts.headless]
   */
  constructor(engine = 'chromium_patched', opts = {}) {
    this.requestedEngine = ENGINES[engine] ? engine : 'chromium_patched';
    this.engine = this.requestedEngine;
    this.opts = opts;
    this.context = null;
    this.pages = [];
    this.profile = null;
    this.fallbackFrom = null;
    this.log = opts.log || createLogger('browser');
  }

  async launch(profile) {
    if (this.context) return this.context;
    this.profile = profile;
    const userDataDir = this.opts.userDataDir
      || (this.opts.profileManager && this.opts.profileManager.userDataDir(profile));
    if (!userDataDir) throw new Error('BrowserAdapter.launch: no userDataDir for profile');
    const headless = this.opts.headless !== undefined
      ? Boolean(this.opts.headless)
      : process.env.KONEQTI_HEADLESS === '1';
    const engineMod = ENGINES[this.requestedEngine]();
    const res = await engineMod.launch({ profile, userDataDir, headless, log: this.log });
    this.context = res.context;
    this.engine = res.engine;
    this.fallbackFrom = res.fallback_from || null;
    this.context.on('close', () => {
      this.context = null;
      this.pages = [];
    });
    return this.context;
  }

  async newPage() {
    if (!this.context) throw new Error('BrowserAdapter: launch() first');
    // Persistent contexts open with one blank tab — reuse it instead of leaving it around.
    const existing = this.context.pages().find((p) => !this.pages.includes(p) && p.url() === 'about:blank');
    const page = existing || (await this.context.newPage());
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(45000);
    this.pages.push(page);
    return page;
  }

  isOpen() {
    return Boolean(this.context);
  }

  /** Resolves when the user closes the browser window (used for manual login). */
  waitForClose() {
    return new Promise((resolve) => {
      if (!this.context) return resolve();
      this.context.once('close', () => resolve());
      return undefined;
    });
  }

  async close() {
    const ctx = this.context;
    this.context = null;
    this.pages = [];
    if (!ctx) return;
    try {
      await ctx.close();
    } catch (_) { /* already closed */ }
  }
}

module.exports = { BrowserAdapter, availableEngines, ENGINE_NAMES: Object.keys(ENGINES) };
