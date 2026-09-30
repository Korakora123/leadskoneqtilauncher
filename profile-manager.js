'use strict';
/**
 * Profile manager — browser identities on this PC.
 *
 * Profile Identity Rules (CLAUDE.md):
 *  - fingerprint_seed generated ONCE (crypto random), never changes
 *  - same IP for the profile's lifetime (user IP or the profile's own proxy)
 *  - cookies/session stored per profile (userDataDir), never cleared automatically
 *  - never run two jobs on the same profile at the same time (busy lock)
 *
 * Daily limits are a LOCAL HARD STOP (brain also enforces them) with warmup:
 * week1 25%, week2 50%, week3 75%, week4+ 100%. Counters reset at local midnight.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('profiles');

const SOCIAL_PLATFORMS = ['instagram', 'linkedin', 'facebook', 'tiktok'];
const PLATFORMS = [...SOCIAL_PLATFORMS, 'web'];
const ENGINES = ['cloakbrowser', 'camoufox', 'chromium_patched'];

/** Base daily ACTION limits per account (CLAUDE.md coding rule 3). */
const BASE_DAILY_LIMITS = { instagram: 20, linkedin: 20, facebook: 15, tiktok: 15 };
/** Read-only page views (scrapes/checks) allowed per day = action limit × this. */
const VIEW_MULTIPLIER = 5;

const LOGIN_URLS = {
  instagram: 'https://www.instagram.com/accounts/login/',
  linkedin: 'https://www.linkedin.com/login',
  facebook: 'https://www.facebook.com/login/',
  tiktok: 'https://www.tiktok.com/login',
  web: 'https://www.google.com/maps',
};

const DEFAULT_WORKING_HOURS = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], timezone: null };

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseHm(str, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
  if (!m) return fallback;
  const h = Math.min(23, Number(m[1]));
  const min = Math.min(59, Number(m[2]));
  return h * 60 + min;
}

/** Current weekday (0=Sun) and minutes-of-day in the given IANA timezone (or system tz). */
function nowInZone(timezone, now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    return { weekday: wd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch (_) {
    return { weekday: now.getDay(), minutes: now.getHours() * 60 + now.getMinutes() };
  }
}

class ProfileManager {
  /**
   * @param {object} opts
   * @param {import('./store').JsonStore} opts.store
   * @param {string} [opts.baseDir]  where per-profile browser data dirs live
   */
  constructor({ store, baseDir } = {}) {
    if (!store) throw new Error('ProfileManager requires a store');
    this.store = store;
    this.baseDir = baseDir || path.join(store.dir, 'browser-profiles');
    this.busy = new Map(); // profile_id -> job_id
    this.brainLimits = {}; // from brain `welcome.limits`
    try { fs.mkdirSync(this.baseDir, { recursive: true }); } catch (_) { /* ignore */ }
  }

  // ---------- CRUD ----------

  list({ includeSystem = false } = {}) {
    const all = this.store.get('profiles', []) || [];
    return includeSystem ? all : all.filter((p) => !p.system);
  }

  get(id) {
    return this.list({ includeSystem: true }).find((p) => p.id === id) || null;
  }

  _saveAll(profiles) {
    this.store.set('profiles', profiles);
  }

  _update(id, patch) {
    const all = this.list({ includeSystem: true });
    const idx = all.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], ...patch };
    this._saveAll(all);
    return all[idx];
  }

  add({ platform, handle, engine = 'chromium_patched', proxy = null, working_hours, is_canary = false } = {}) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`);
    if (!ENGINES.includes(engine)) throw new Error(`Unknown engine: ${engine}`);
    const cleanHandle = String(handle || '').trim().replace(/^@/, '');
    if (platform !== 'web' && !cleanHandle) throw new Error('Handle is required');
    const dup = this.list().find((p) => p.platform === platform && p.handle.toLowerCase() === cleanHandle.toLowerCase());
    if (dup) throw new Error(`Profile ${platform}/@${cleanHandle} already exists`);

    const now = new Date().toISOString();
    const profile = {
      id: crypto.randomUUID(),
      platform,
      handle: cleanHandle,
      engine,
      fingerprint_seed: crypto.randomBytes(16).toString('hex'), // generated ONCE
      proxy: proxy || null,
      created_at: now,
      warmup_started_at: now,
      working_hours: { ...DEFAULT_WORKING_HOURS, ...(working_hours || {}) },
      status: 'active',
      paused_until: null,
      attention: null, // e.g. 'logged_out' | 'captcha' — cleared when user re-opens browser
      is_canary: Boolean(is_canary),
      system: false,
      daily_counters: { date: localDateKey(), actions: 0, views: 0 },
      last_used_at: null,
    };
    const all = this.list({ includeSystem: true });
    all.push(profile);
    this._saveAll(all);
    log.info('profile added', { id: profile.id, platform });
    return profile;
  }

  async remove(id) {
    const p = this.get(id);
    if (!p) return false;
    if (this.busy.has(id)) throw new Error('Profile is busy — try again when its job finishes');
    this._saveAll(this.list({ includeSystem: true }).filter((x) => x.id !== id));
    try {
      await fs.promises.rm(this.userDataDir(p), { recursive: true, force: true });
    } catch (err) {
      log.warn('could not delete profile data dir', { id, err: err.message });
    }
    log.info('profile removed', { id });
    return true;
  }

  setWorkingHours(id, hours) {
    const p = this.get(id);
    if (!p) throw new Error('Profile not found');
    const wh = { ...DEFAULT_WORKING_HOURS, ...p.working_hours, ...(hours || {}) };
    if (parseHm(wh.start, -1) < 0 || parseHm(wh.end, -1) < 0) throw new Error('Hours must be HH:MM');
    wh.days = (Array.isArray(wh.days) ? wh.days : DEFAULT_WORKING_HOURS.days)
      .map(Number).filter((d) => d >= 0 && d <= 6);
    return this._update(id, { working_hours: wh });
  }

  setProxy(id, proxy) {
    // Changing the IP of an existing identity breaks rule "1 profile = 1 IP".
    const p = this.get(id);
    if (!p) throw new Error('Profile not found');
    if (p.proxy && proxy !== p.proxy) throw new Error('Proxy of an existing profile cannot be changed — create a new profile');
    return this._update(id, { proxy: proxy || null });
  }

  /** Called when the user re-opens the profile browser to fix a login/challenge. */
  clearAttention(id) {
    return this._update(id, { attention: null, paused_until: null, status: 'active' });
  }

  markAttention(id, event) {
    const patch = { attention: event };
    if (event === 'logged_out') patch.status = 'paused';
    if (event === 'captcha' || event === 'challenge') {
      patch.status = 'paused';
      patch.paused_until = new Date(Date.now() + 24 * 3600e3).toISOString();
    }
    if (event === 'restricted') {
      patch.status = 'restricted';
      patch.paused_until = new Date(Date.now() + 7 * 24 * 3600e3).toISOString();
    }
    return this._update(id, patch);
  }

  touch(id) {
    return this._update(id, { last_used_at: new Date().toISOString() });
  }

  /** System "web" profiles (no login) used for maps/websites/screenshots — one per engine slot. */
  ensureWebProfile(engine = 'chromium_patched', slot = 1) {
    const id = `web-${engine}-${slot}`;
    const existing = this.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const profile = {
      id,
      platform: 'web',
      handle: `web-${slot}`,
      engine,
      fingerprint_seed: crypto.randomBytes(16).toString('hex'),
      proxy: null,
      created_at: now,
      warmup_started_at: now,
      working_hours: null,
      status: 'active',
      paused_until: null,
      attention: null,
      is_canary: false,
      system: true,
      daily_counters: { date: localDateKey(), actions: 0, views: 0 },
      last_used_at: null,
    };
    const all = this.list({ includeSystem: true });
    all.push(profile);
    this._saveAll(all);
    return profile;
  }

  userDataDir(profile) {
    const safe = String(profile.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, safe);
  }

  // ---------- Busy lock ----------

  isBusy(id) {
    return this.busy.has(id);
  }

  acquire(id, jobId) {
    if (this.busy.has(id)) return false;
    this.busy.set(id, jobId);
    return true;
  }

  release(id, jobId) {
    if (this.busy.get(id) === jobId || jobId === undefined) this.busy.delete(id);
  }

  // ---------- Limits / warmup ----------

  setBrainLimits(limits) {
    this.brainLimits = limits && typeof limits === 'object' ? { ...limits } : {};
  }

  warmupWeek(profile, now = Date.now()) {
    const start = Date.parse(profile.warmup_started_at || profile.created_at || new Date(now).toISOString());
    const days = Math.max(0, Math.floor((now - start) / 86400e3));
    return Math.floor(days / 7) + 1; // 1-based
  }

  warmupPct(profile, now = Date.now()) {
    const week = this.warmupWeek(profile, now);
    if (week <= 1) return 0.25;
    if (week === 2) return 0.5;
    if (week === 3) return 0.75;
    return 1;
  }

  /** Effective daily limit for a category ('actions' | 'views'); null = unlimited. */
  dailyLimit(profile, category = 'actions') {
    if (!profile || profile.platform === 'web') return null;
    const local = BASE_DAILY_LIMITS[profile.platform];
    if (!local) return null;
    const brain = Number(this.brainLimits[profile.platform]);
    const base = Number.isFinite(brain) && brain > 0 ? Math.min(local, brain) : local;
    const limit = Math.max(1, Math.floor(base * this.warmupPct(profile)));
    return category === 'views' ? limit * VIEW_MULTIPLIER : limit;
  }

  _counters(profile) {
    const today = localDateKey();
    const c = profile.daily_counters || {};
    if (c.date !== today) return { date: today, actions: 0, views: 0 };
    return { date: today, actions: Number(c.actions) || 0, views: Number(c.views) || 0 };
  }

  usage(profile) {
    return this._counters(profile);
  }

  canRun(profile, category) {
    if (!category || category === 'none') return { ok: true };
    const limit = this.dailyLimit(profile, category);
    if (limit === null) return { ok: true };
    const used = this._counters(profile)[category] || 0;
    if (used >= limit) return { ok: false, reason: 'daily_limit_reached', used, limit };
    return { ok: true, used, limit };
  }

  increment(id, category, by = 1) {
    if (!category || category === 'none') return null;
    const p = this.get(id);
    if (!p) return null;
    const c = this._counters(p);
    c[category] = (c[category] || 0) + by;
    return this._update(id, { daily_counters: c });
  }

  // ---------- Working hours ----------

  /** Returns { allowed, reason? } — sessions only inside the profile's working hours. */
  sessionWindow(profile, now = new Date()) {
    if (!profile || profile.platform === 'web' || !profile.working_hours) return { allowed: true };
    if (profile.paused_until && Date.parse(profile.paused_until) > now.getTime()) {
      return { allowed: false, reason: 'profile_paused' };
    }
    const wh = profile.working_hours;
    const { weekday, minutes } = nowInZone(wh.timezone, now);
    const days = Array.isArray(wh.days) ? wh.days : DEFAULT_WORKING_HOURS.days;
    if (!days.includes(weekday)) return { allowed: false, reason: 'outside_working_hours' };
    const start = parseHm(wh.start, 9 * 60);
    const end = parseHm(wh.end, 18 * 60);
    const inside = start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    return inside ? { allowed: true } : { allowed: false, reason: 'outside_working_hours' };
  }

  // ---------- Views for brain / UI ----------

  statusOf(p) {
    if (p.status === 'restricted') return 'restricted';
    if (p.status === 'paused' || p.attention) return 'paused';
    if (p.platform !== 'web' && this.warmupWeek(p) < 4) return 'warming';
    return 'active';
  }

  /** Shape sent to brain in hello/profile_update. */
  forBrain() {
    return this.list().map((p) => ({
      profile_id: p.id,
      platform: p.platform,
      handle: p.handle,
      engine: p.engine,
      status: this.statusOf(p),
      fingerprint_seed: p.fingerprint_seed,
      proxy: p.proxy ? true : null, // never send proxy credentials — only whether one is set
      warmup_started_at: p.warmup_started_at,
      daily_limit: this.dailyLimit(p, 'actions'),
      used_today: this._counters(p).actions,
      is_canary: p.is_canary,
    }));
  }

  /** Shape for the renderer UI. */
  forUi() {
    return this.list().map((p) => ({
      id: p.id,
      platform: p.platform,
      handle: p.handle,
      engine: p.engine,
      status: this.statusOf(p),
      attention: p.attention,
      busy: this.isBusy(p.id),
      used_today: this._counters(p).actions,
      daily_limit: this.dailyLimit(p, 'actions'),
      warmup_week: Math.min(4, this.warmupWeek(p)),
      warmup_pct: Math.round(this.warmupPct(p) * 100),
      working_hours: p.working_hours,
      has_proxy: Boolean(p.proxy),
      is_canary: p.is_canary,
    }));
  }
}

module.exports = {
  ProfileManager,
  PLATFORMS,
  SOCIAL_PLATFORMS,
  ENGINES,
  BASE_DAILY_LIMITS,
  LOGIN_URLS,
  DEFAULT_WORKING_HOURS,
  localDateKey,
  nowInZone,
};
