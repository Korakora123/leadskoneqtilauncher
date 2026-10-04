'use strict';
/**
 * Job runner — executes brain jobs on this PC.
 *
 *  - concurrency 1-2 overall (configurable)
 *  - one job per profile at a time (busy lock)
 *  - checks: platform paused, device paused, deadline, profile paused/attention,
 *    working hours, daily limit (local HARD STOP with warmup)
 *  - launches the browser ONLY through BrowserAdapter
 *  - runs the job module, detects challenges (captcha / unusual activity / blocked /
 *    logged out) → job_result warnings + account_event, always closes the context
 *
 * Executor-agnostic: no Electron imports. Communication goes through the `send`
 * callback, so a future cloud executor can reuse this file unchanged.
 */
const { EventEmitter } = require('events');
const { BrowserAdapter } = require('./browser/adapter');
const { executeRecipe, RecipeError } = require('./recipe-executor');
const { detectChallenges, BLOCKING_WARNINGS } = require('./detection');
const behavior = require('./behavior');
const { getJob, platformOf, categoryOf } = require('./jobs');
const { LOGIN_PLATFORMS, LOGIN_URLS } = require('./profile-manager');
const { createLogger } = require('./logger');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const RECENT_RESULTS_MAX = 300;

class JobRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./profile-manager').ProfileManager} o.profileManager
   * @param {(type:string, payload:object)=>void} o.send   message to brain
   * @param {(req:{job_id,step_id,goal,accessibility_tree})=>Promise<string|null>} [o.requestSelector]
   * @param {(files:object[], meta:object)=>Promise<object[]>} [o.upload]
   * @param {(url:string)=>Promise<Response>} [o.download]
   * @param {number} [o.concurrency]
   * @param {boolean} [o.headless]
   */
  constructor(o) {
    super();
    this.pm = o.profileManager;
    this.send = o.send || (() => {});
    this.requestSelector = o.requestSelector || null;
    this.uploadFn = o.upload || null;
    this.downloadFn = o.download || ((url) => fetch(url));
    this.concurrency = clampConcurrency(o.concurrency);
    this.headless = o.headless;
    this.log = o.log || createLogger('runner');
    this.queue = [];
    this.running = new Map(); // job_id -> entry
    this.pausedPlatforms = new Map(); // platform -> reason
    this.pausedAll = false;
    this.recent = new Map(); // job_id -> result payload (dedupe re-sent jobs)
    this.manualSessions = new Map(); // profile_id -> adapter
  }

  // ---------------- public API ----------------

  setConcurrency(n) {
    this.concurrency = clampConcurrency(n);
    this._pump();
  }

  setPausedAll(paused) {
    this.pausedAll = Boolean(paused);
    if (this.pausedAll) {
      for (const job of this.queue.splice(0)) this._result(job, { status: 'skipped', error: 'device_paused' });
    }
    this._emitStatus();
    this._pump();
  }

  pausePlatform(platform, reason) {
    if (!platform) return;
    this.pausedPlatforms.set(platform, reason || 'paused_by_brain');
    const keep = [];
    for (const job of this.queue) {
      const mod = getJob(job.job_type);
      if (mod && platformOf(mod, job) === platform) this._result(job, { status: 'skipped', error: 'platform_paused' });
      else keep.push(job);
    }
    this.queue = keep;
    this._emitStatus();
  }

  resumePlatform(platform) {
    this.pausedPlatforms.delete(platform);
    this._emitStatus();
    this._pump();
  }

  setPausedPlatforms(list) {
    this.pausedPlatforms = new Map((list || []).map((p) => [p, 'paused_by_brain']));
    this._emitStatus();
  }

  runningJobIds() {
    return [...this.running.keys()];
  }

  status() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      running_jobs: [...this.running.values()].map((e) => ({ job_id: e.job.job_id, job_type: e.job.job_type, profile_id: e.profile && e.profile.id })),
      paused_all: this.pausedAll,
      paused_platforms: [...this.pausedPlatforms.keys()],
      concurrency: this.concurrency,
    };
  }

  /** Accept a `job` message payload from the brain. Returns true if accepted. */
  enqueue(job) {
    try {
      if (!job || !job.job_id || !job.job_type) return false;
      if (this.running.has(job.job_id) || this.queue.some((j) => j.job_id === job.job_id)) return true;
      if (this.recent.has(job.job_id)) {
        // Brain re-sent a job we already finished (e.g. after reconnect) → re-send the result, never re-run.
        this.send('job_result', this.recent.get(job.job_id));
        return true;
      }
      if (!getJob(job.job_type)) {
        this._result(job, { status: 'failed', error: `unknown_job_type:${job.job_type}` });
        return true;
      }
      if (this.pausedAll) {
        this._result(job, { status: 'skipped', error: 'device_paused' });
        return true;
      }
      this.queue.push({ ...job, _received_at: Date.now() });
      this.log.info('job queued', { job_id: job.job_id, job_type: job.job_type });
      this._emitStatus();
      this._pump();
      return true;
    } catch (err) {
      this.log.error('enqueue failed', { job_id: job && job.job_id, err: err.message });
      return false;
    }
  }

  cancel(jobId) {
    const idx = this.queue.findIndex((j) => j.job_id === jobId);
    if (idx >= 0) {
      const [job] = this.queue.splice(idx, 1);
      this._result(job, { status: 'skipped', error: 'cancelled' });
      this._emitStatus();
      return true;
    }
    const entry = this.running.get(jobId);
    if (entry) {
      entry.controller.abort();
      if (entry.adapter) entry.adapter.close().catch(() => {});
      return true;
    }
    return false;
  }

  /** Cancel everything (app quit). */
  async shutdown() {
    this.pausedAll = true;
    for (const job of this.queue.splice(0)) this._result(job, { status: 'skipped', error: 'device_shutdown' });
    for (const id of [...this.running.keys()]) this.cancel(id);
    for (const [, adapter] of this.manualSessions) await adapter.close().catch(() => {});
  }

  /**
   * Open a profile's browser (headed) so the user can log in to Instagram / LinkedIn / etc.
   * manually. Holds the profile lock until the user closes the window.
   */
  async openProfileBrowser(profileId) {
    const profile = this.pm.get(profileId);
    if (!profile) throw new Error('Profile not found');
    if (this.manualSessions.has(profileId)) return { already_open: true };
    if (!this.pm.acquire(profileId, 'manual-login')) throw new Error('Profile is running a job — try again in a minute');
    const adapter = new BrowserAdapter(profile.engine, { profileManager: this.pm, headless: false, log: this.log });
    try {
      await adapter.launch(profile);
      const page = await adapter.newPage();
      this.manualSessions.set(profileId, adapter);
      this._emitStatus();
      page.goto(LOGIN_URLS[profile.platform] || 'about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
      adapter.waitForClose().then(() => {
        this.manualSessions.delete(profileId);
        this.pm.release(profileId, 'manual-login');
        this.pm.clearAttention(profileId);
        this._profileUpdate();
        this._emitStatus();
        this._pump();
      });
      return { opened: true, engine: adapter.engine };
    } catch (err) {
      this.manualSessions.delete(profileId);
      this.pm.release(profileId, 'manual-login');
      await adapter.close();
      throw err;
    }
  }

  // ---------------- scheduling ----------------

  _pump() {
    try {
      if (this.pausedAll) return;
      let progressed = true;
      while (progressed && this.running.size < this.concurrency && this.queue.length) {
        progressed = false;
        for (let i = 0; i < this.queue.length; i += 1) {
          const job = this.queue[i];
          const decision = this._decide(job);
          if (decision.wait) continue; // profile busy → try later
          this.queue.splice(i, 1);
          if (decision.result) {
            this._result(job, decision.result);
          } else {
            this._start(job, decision);
          }
          progressed = true;
          break;
        }
      }
      this._emitStatus();
    } catch (err) {
      this.log.error('pump error', { err: err.message });
    }
  }

  /** Decide what to do with a queued job: start (with profile), wait, or finish with a result. */
  _decide(job) {
    const mod = getJob(job.job_type);
    const platform = platformOf(mod, job) || 'web';
    const category = categoryOf(mod, job) || 'none';

    if (job.deadline && Date.parse(job.deadline) < Date.now()) {
      return { result: { status: 'skipped', error: 'deadline_passed' } };
    }
    if (this.pausedPlatforms.has(platform)) {
      return { result: { status: 'skipped', error: 'platform_paused' } };
    }

    // Web jobs (no login): use a system web profile slot.
    if (!LOGIN_PLATFORMS.includes(platform)) {
      if (job.profile_id && this.pm.get(job.profile_id)) {
        const p = this.pm.get(job.profile_id);
        if (this.pm.isBusy(p.id)) return { wait: true };
        return { profile: p, platform, category, engine: p.engine };
      }
      const engine = job.engine || 'chromium_patched';
      for (let slot = 1; slot <= this.concurrency; slot += 1) {
        const p = this.pm.ensureWebProfile(engine, slot);
        if (!this.pm.isBusy(p.id)) return { profile: p, platform, category, engine };
      }
      return { wait: true };
    }

    // Login jobs (social accounts + load boards): pick the user's profile for that platform.
    let candidates;
    if (job.profile_id) {
      const p = this.pm.get(job.profile_id);
      if (!p) return { result: { status: 'failed', error: 'profile_not_found' } };
      if (p.platform !== platform) return { result: { status: 'failed', error: 'profile_platform_mismatch' } };
      candidates = [p];
    } else {
      candidates = this.pm.list().filter((p) => p.platform === platform
        && (job.job_type === 'canary_routine' ? p.is_canary : !p.is_canary));
      if (!candidates.length) return { result: { status: 'failed', error: `no_profile_for_platform:${platform}` } };
    }

    let firstReason = null;
    let anyBusy = false;
    for (const p of candidates) {
      if (this.pm.isBusy(p.id)) { anyBusy = true; continue; }
      if (p.attention || p.status === 'restricted' || p.status === 'paused') {
        const until = p.paused_until ? Date.parse(p.paused_until) : null;
        const expired = until && until <= Date.now() && p.attention !== 'logged_out';
        if (expired) {
          this.pm.clearAttention(p.id); // cool-down over (brain still applies its own 7-day rule)
        } else {
          firstReason = firstReason || {
            status: 'skipped',
            error: `profile_needs_attention:${p.attention || p.status}`,
            warnings: p.attention === 'logged_out' ? ['logged_out'] : [],
          };
          continue;
        }
      }
      const win = this.pm.sessionWindow(p);
      if (!win.allowed) { firstReason = firstReason || { status: 'skipped', error: win.reason }; continue; }
      const lim = this.pm.canRun(p, category);
      if (!lim.ok) {
        firstReason = firstReason || { status: 'skipped', error: lim.reason, warnings: ['rate_limited'], data: { used: lim.used, limit: lim.limit } };
        continue;
      }
      // Profile engine wins: 1 profile = 1 fingerprint for its whole life.
      return { profile: p, platform, category, engine: p.engine || job.engine };
    }
    if (anyBusy) return { wait: true };
    return { result: firstReason || { status: 'skipped', error: 'no_available_profile' } };
  }

  _start(job, { profile, platform, category, engine }) {
    if (!this.pm.acquire(profile.id, job.job_id)) {
      this.queue.unshift(job);
      return;
    }
    const entry = {
      job,
      profile,
      platform,
      category,
      engine,
      controller: new AbortController(),
      adapter: null,
      startedAt: Date.now(),
      meta: { ai_selectors_used: [], skipped_steps: [], screenshots: [] },
    };
    this.running.set(job.job_id, entry);
    this.log.info('job started', { job_id: job.job_id, job_type: job.job_type, profile_id: profile.id });
    this._emitStatus();
    this._execute(entry)
      .catch((err) => this.log.error('execute crashed', { job_id: job.job_id, err: err.message }))
      .finally(() => {
        this.running.delete(job.job_id);
        this.pm.release(profile.id, job.job_id);
        this.pm.touch(profile.id);
        this._emitStatus();
        setImmediate(() => this._pump());
      });
  }

  // ---------------- execution ----------------

  async _execute(entry) {
    const { job, profile, platform, category } = entry;
    const mod = getJob(job.job_type);
    const signal = entry.controller.signal;
    const social = LOGIN_PLATFORMS.includes(platform);
    const adapter = new BrowserAdapter(entry.engine || 'chromium_patched', {
      profileManager: this.pm,
      headless: this.headless,
      log: this.log,
    });
    entry.adapter = adapter;

    let page = null;
    let outcome;
    const timeoutMs = Math.min(Number(job.timeout_ms) || DEFAULT_TIMEOUT_MS, 60 * 60 * 1000);
    const timer = setTimeout(() => {
      entry.timedOut = true;
      entry.controller.abort();
      adapter.close().catch(() => {});
    }, timeoutMs);

    try {
      this._progress(job, 'launch', `launching ${adapter.requestedEngine}`);
      await adapter.launch(profile);
      page = await adapter.newPage();
      if (signal.aborted) throw new Error('cancelled');

      const ctx = this._buildCtx(entry, page, adapter);
      const res = await mod.run(ctx);
      outcome = { status: 'success', data: (res && res.data) || {}, warnings: (res && res.warnings) || [], countAction: res && res.countAction };
    } catch (err) {
      outcome = this._mapError(err, entry);
    } finally {
      clearTimeout(timer);
    }

    // Challenge detection on whatever page we ended on.
    let detected = { warnings: [], events: [] };
    try {
      if (page && !signal.aborted) detected = await detectChallenges(page, social ? { platform } : {});
    } catch (_) { /* ignore */ }

    await adapter.close();

    const warnings = new Set([...(outcome.warnings || []), ...detected.warnings]);
    const blocking = detected.warnings.some((w) => BLOCKING_WARNINGS.includes(w));
    if (outcome.status === 'failed' && blocking) outcome.status = 'blocked';
    // A successful send stays 'success' (never make the brain retry a sent message) but carries warnings.

    // A recipe guard (check_text on_match: abort_blocked) may block without the detector seeing it.
    const events = [...detected.events];
    if (outcome.status === 'blocked' && !events.length) {
      const map = { captcha_detected: 'captcha', unusual_activity: 'challenge', action_blocked: 'restricted', logged_out: 'logged_out' };
      const w = (outcome.warnings || []).find((x) => map[x]);
      events.push({ event: w ? map[w] : 'challenge', detail: `recipe guard: ${outcome.failed_step || 'check_text'}` });
    }
    for (const ev of events) {
      this.send('account_event', { profile_id: profile.id, platform, event: ev.event, detail: ev.detail });
      if (social) this.pm.markAttention(profile.id, ev.event);
    }

    // Counters: views count whenever the page was opened; actions only on success.
    if (category === 'views' && page) this.pm.increment(profile.id, 'views');
    if (category === 'actions' && outcome.status === 'success' && outcome.countAction !== false) this.pm.increment(profile.id, 'actions');

    const meta = {
      engine: adapter.engine,
      fallback_from: adapter.fallbackFrom,
      profile_id: profile.system ? null : profile.id,
      duration_ms: Date.now() - entry.startedAt,
    };
    if (entry.meta.ai_selectors_used.length) meta.ai_selectors_used = entry.meta.ai_selectors_used;
    if (entry.meta.skipped_steps.length) meta.skipped_steps = entry.meta.skipped_steps;

    // Optional: upload recipe screenshots (debug / confirmation) when the brain asks for them.
    if (job.payload && job.payload.upload_recipe_screenshots && entry.meta.screenshots.length && this.uploadFn) {
      try {
        const up = await this.uploadFn(entry.meta.screenshots, { kind: 'recipe_screenshot', job_id: job.job_id, prospect_id: job.payload.prospect_id || null });
        meta.screenshots = up;
      } catch (err) {
        meta.screenshots_error = err.message;
      }
    }

    this._result(job, {
      status: outcome.status,
      // A job may add its own _meta keys (e.g. search_load_board pacing); runner keys win.
      data: { ...(outcome.data || {}), _meta: { ...((outcome.data && outcome.data._meta) || {}), ...meta } },
      error: outcome.error,
      warnings: [...warnings],
      failed_step: outcome.failed_step,
    });
    if (social) this._profileUpdate();
  }

  _mapError(err, entry) {
    const msg = (err && err.message) || 'job_failed';
    if (entry.timedOut) return { status: 'failed', error: 'job_timeout' };
    if (entry.controller.signal.aborted || msg === 'cancelled') return { status: 'skipped', error: 'cancelled' };
    if (err && err.name === 'JobError') {
      return { status: err.status || 'failed', error: msg, warnings: err.warnings || [], failed_step: err.failed_step || undefined, data: err.data };
    }
    if (err instanceof RecipeError) {
      return { status: err.blocked ? 'blocked' : 'failed', error: msg, warnings: err.warnings || [], failed_step: err.failed_step || undefined, data: err.partial ? { partial: err.partial.data } : undefined };
    }
    if (/Executable doesn't exist|Chrome was not found|Failed to launch/i.test(msg)) {
      return { status: 'failed', error: 'browser_launch_failed' };
    }
    return { status: 'failed', error: msg.split('\n')[0].slice(0, 300) };
  }

  _buildCtx(entry, page, adapter) {
    const { job, profile, platform } = entry;
    const payload = job.payload || {};
    const signal = entry.controller.signal;
    const self = this;
    return {
      job,
      payload,
      page,
      browser: adapter,
      profile: { id: profile.id, platform: profile.platform, handle: profile.handle },
      platform,
      signal,
      behavior,
      log: this.log,
      progress: (step, message) => self._progress(job, step, message),
      async runRecipe(vars = {}, recipe = job.recipe) {
        const res = await executeRecipe(page, recipe, {
          vars: { ...payload, ...vars },
          signal,
          onProgress: (step, action) => self._progress(job, step, action),
          requestSelector: self.requestSelector
            ? (req) => self.requestSelector({ job_id: job.job_id, ...req })
            : null,
        });
        entry.meta.ai_selectors_used.push(...res.ai_selectors_used);
        entry.meta.skipped_steps.push(...res.skipped_steps);
        entry.meta.screenshots.push(...res.screenshots);
        return res;
      },
      async upload(files, meta = {}) {
        if (!self.uploadFn) throw new Error('upload_not_configured');
        return self.uploadFn(files, { ...meta, job_id: job.job_id });
      },
      download: (url) => self.downloadFn(url),
      async detect() {
        const d = await detectChallenges(page, LOGIN_PLATFORMS.includes(platform) ? { platform } : {});
        return { ...d, blocking: d.warnings.some((w) => BLOCKING_WARNINGS.includes(w)) };
      },
    };
  }

  // ---------------- messaging ----------------

  _progress(job, step, message) {
    try {
      this.send('job_progress', { job_id: job.job_id, step: String(step || ''), message: String(message || '').slice(0, 200) });
    } catch (_) { /* ignore */ }
  }

  _result(job, r) {
    const payload = {
      job_id: job.job_id,
      status: r.status,
      data: r.data || {},
    };
    if (r.error) payload.error = r.error;
    if (r.warnings && r.warnings.length) payload.warnings = [...new Set(r.warnings)];
    if (job.recipe && job.recipe.version !== undefined) payload.recipe_version = job.recipe.version;
    if (r.failed_step) payload.failed_step = r.failed_step;
    this.recent.set(job.job_id, payload);
    if (this.recent.size > RECENT_RESULTS_MAX) this.recent.delete(this.recent.keys().next().value);
    this.log.info('job finished', { job_id: job.job_id, status: payload.status, error: payload.error });
    try {
      this.send('job_result', payload);
    } catch (err) {
      this.log.error('send result failed', { job_id: job.job_id, err: err.message });
    }
    this.emit('job_finished', payload);
  }

  _profileUpdate() {
    try {
      this.send('profile_update', { profiles: this.pm.forBrain() });
    } catch (_) { /* ignore */ }
    this.emit('profiles_changed');
  }

  _emitStatus() {
    this.emit('status', this.status());
  }
}

function clampConcurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(2, Math.round(v)));
}

module.exports = { JobRunner };
