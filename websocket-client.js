'use strict';
/**
 * WebSocket client → brain (CONTRACTS.md §3).
 *
 *   URL:    BRAIN_WS_URL (ws://<BRAIN_HOST>:4100/ws)
 *   Header: x-electron-secret: <ELECTRON_SECRET>
 *   Frame:  { type, id?, payload }
 *
 * Client → Brain: hello, heartbeat (30s), job_ack, job_progress, job_result,
 *                 ai_selector_request, account_event, profile_update
 * Brain → Client: welcome, job, ai_selector_response, cancel_job,
 *                 pause_platform, resume_platform, pong, error
 *
 * Exponential reconnect backoff (1s → 60s, jitter); Supabase token refresh before
 * reconnecting when auth failed or the token is close to expiry. Results produced
 * while offline are buffered and flushed after the next `welcome`.
 * No Electron imports.
 */
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createLogger } = require('./logger');

const HEARTBEAT_MS = 30000;
const STALE_MS = 95000; // no frame from brain for this long → reconnect
const AI_TIMEOUT_MS = 30000;
const BUFFERED_TYPES = new Set(['job_result', 'account_event', 'profile_update']);
const OUTBOX_MAX = 500;

class CpuSampler {
  constructor() { this.prev = this._snap(); }

  _snap() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const v of Object.values(c.times)) total += v;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  percent() {
    const cur = this._snap();
    const dIdle = cur.idle - this.prev.idle;
    const dTotal = cur.total - this.prev.total;
    this.prev = cur;
    if (dTotal <= 0) return 0;
    return Math.round((1 - dIdle / dTotal) * 1000) / 10;
  }
}

class BrainClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url
   * @param {string} o.secret
   * @param {{getAccessToken:()=>Promise<string|null>, getSession:()=>Promise<any>, refresh:()=>Promise<any>}} o.auth
   * @param {string} o.deviceId
   * @param {string} o.appVersion
   * @param {import('./playwright-runner').JobRunner} [o.runner]  (attach later with setRunner)
   * @param {import('./profile-manager').ProfileManager} o.profileManager
   * @param {() => string[]} o.engines
   */
  constructor(o) {
    super();
    this.url = o.url;
    this.secret = o.secret || '';
    this.auth = o.auth;
    this.deviceId = o.deviceId;
    this.appVersion = o.appVersion || '0.0.0';
    this.runner = o.runner || null;
    this.pm = o.profileManager;
    this.engines = o.engines || (() => ['chromium_patched']);
    this.log = o.log || createLogger('ws');

    this.ws = null;
    this.state = 'idle'; // idle | connecting | connected | offline | unauthenticated | stopped
    this.welcomed = false;
    this.userId = null;
    this.attempt = 0;
    this.authFailed = false;
    this.stopped = true;
    this.timers = { heartbeat: null, reconnect: null, stale: null };
    this.outbox = [];
    this.pendingAi = new Map();
    this.cpu = new CpuSampler();
    this.lastError = null;
  }

  setRunner(runner) {
    this.runner = runner;
  }

  // ---------------- lifecycle ----------------

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'client_stop'); } catch (_) { /* ignore */ }
    }
    this.ws = null;
    this._setState('stopped');
  }

  isConnected() {
    return this.state === 'connected' && this.welcomed;
  }

  status() {
    return {
      state: this.state,
      connected: this.isConnected(),
      user_id: this.userId,
      last_error: this.lastError,
      outbox: this.outbox.length,
    };
  }

  async _connect() {
    if (this.stopped) return;
    try {
      if (!this.url) {
        this.lastError = 'BRAIN_WS_URL not configured';
        this._setState('offline');
        return;
      }
      await this._maybeRefresh();
      const token = await this.auth.getAccessToken();
      if (!token) {
        this.lastError = 'not_logged_in';
        this._setState('unauthenticated');
        return;
      }
      this._setState('connecting');
      const ws = new WebSocket(this.url, {
        headers: { 'x-electron-secret': this.secret },
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      });
      this.ws = ws;

      ws.on('open', () => {
        this.attempt = 0;
        this._raw({
          type: 'hello',
          payload: {
            access_token: token,
            device_id: this.deviceId,
            app_version: this.appVersion,
            platform: process.platform,
            engines: this.engines(),
            profiles: this.pm.forBrain(),
          },
        });
        this._touchStale();
      });
      ws.on('message', (buf) => this._onMessage(buf));
      ws.on('unexpected-response', (_req, res) => {
        this.lastError = `handshake_http_${res.statusCode}`;
        if (res.statusCode === 401 || res.statusCode === 403) this.authFailed = true;
      });
      ws.on('error', (err) => {
        this.lastError = err.message;
        this.log.warn('ws error', { err: err.message });
      });
      ws.on('close', (code) => this._onClose(code));
    } catch (err) {
      this.lastError = err.message;
      this.log.error('connect failed', { err: err.message });
      this._scheduleReconnect();
    }
  }

  async _maybeRefresh() {
    try {
      const session = await this.auth.getSession();
      if (!session) return;
      const expMs = (session.expires_at || 0) * 1000;
      if (this.authFailed || (expMs && expMs - Date.now() < 10 * 60 * 1000)) {
        await this.auth.refresh();
        this.authFailed = false;
      }
    } catch (_) { /* ignore */ }
  }

  _onClose(code) {
    this.ws = null;
    this.welcomed = false;
    clearInterval(this.timers.heartbeat);
    clearTimeout(this.timers.stale);
    for (const [, p] of this.pendingAi) { clearTimeout(p.timer); p.resolve(null); }
    this.pendingAi.clear();
    if (code === 4001 || code === 4003 || code === 1008) this.authFailed = true;
    if (this.stopped) return;
    this._setState('offline');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timers.reconnect);
    const base = Math.min(60000, 1000 * 2 ** Math.min(this.attempt, 6));
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.attempt += 1;
    this.log.info('reconnecting', { in_ms: delay, attempt: this.attempt });
    this.timers.reconnect = setTimeout(() => this._connect(), delay);
  }

  /** Force a reconnect now (e.g. after login or network change). */
  reconnectNow() {
    this.stopped = false;
    this.attempt = 0;
    clearTimeout(this.timers.reconnect);
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) { /* ignore */ }
      return; // close handler schedules reconnect
    }
    this._connect();
  }

  _clearTimers() {
    clearInterval(this.timers.heartbeat);
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.stale);
  }

  _touchStale() {
    clearTimeout(this.timers.stale);
    this.timers.stale = setTimeout(() => {
      this.log.warn('brain silent — reconnecting');
      if (this.ws) {
        try { this.ws.terminate(); } catch (_) { /* ignore */ }
      }
    }, STALE_MS);
  }

  _startHeartbeat() {
    clearInterval(this.timers.heartbeat);
    const beat = () => {
      this._raw({
        type: 'heartbeat',
        payload: {
          running_jobs: this.runner ? this.runner.runningJobIds() : [],
          cpu: this.cpu.percent(),
          free_mem_mb: Math.round(os.freemem() / 1048576),
          paused: this.runner ? this.runner.pausedAll : false,
        },
      });
    };
    beat();
    this.timers.heartbeat = setInterval(beat, HEARTBEAT_MS);
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.status());
  }

  // ---------------- inbound ----------------

  _onMessage(buf) {
    this._touchStale();
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (_) {
      return;
    }
    const payload = (msg && msg.payload) || {};
    try {
      switch (msg.type) {
        case 'welcome':
          this.welcomed = true;
          this.userId = payload.user_id || null;
          this.lastError = null;
          if (this.pm) this.pm.setBrainLimits(payload.limits || {});
          if (this.runner) this.runner.setPausedPlatforms(payload.paused_platforms || []);
          this._setState('connected');
          this.emit('status', this.status());
          this._startHeartbeat();
          this._flushOutbox();
          this.log.info('connected to brain');
          break;
        case 'job':
          this._raw({ type: 'job_ack', payload: { job_id: payload.job_id } });
          if (this.runner) this.runner.enqueue(payload);
          break;
        case 'cancel_job':
          if (this.runner) this.runner.cancel(payload.job_id);
          break;
        case 'pause_platform':
          if (this.runner) this.runner.pausePlatform(payload.platform, payload.reason);
          this.emit('platform_paused', payload);
          break;
        case 'resume_platform':
          if (this.runner) this.runner.resumePlatform(payload.platform);
          break;
        case 'ai_selector_response': {
          const key = `${payload.job_id}:${payload.step_id}`;
          const p = this.pendingAi.get(key);
          if (p) {
            clearTimeout(p.timer);
            this.pendingAi.delete(key);
            p.resolve(typeof payload.selector === 'string' && payload.selector ? payload.selector : null);
          }
          break;
        }
        case 'pong':
          break;
        case 'error':
          this.lastError = String(payload.message || 'brain_error').slice(0, 200);
          this.log.warn('brain error', { message: this.lastError });
          if (/auth|token|unauthori[sz]ed|expired|jwt/i.test(this.lastError)) this.authFailed = true;
          this.emit('status', this.status());
          break;
        default:
          break;
      }
    } catch (err) {
      this.log.error('message handling failed', { type: msg.type, err: err.message });
    }
  }

  // ---------------- outbound ----------------

  _raw(msg) {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify({ id: crypto.randomUUID(), ...msg }));
      return true;
    } catch (err) {
      this.log.warn('send failed', { type: msg.type, err: err.message });
      return false;
    }
  }

  /** Send a protocol message; results/events are buffered while offline. */
  send(type, payload) {
    if (this.isConnected() && this._raw({ type, payload })) return true;
    if (BUFFERED_TYPES.has(type)) {
      if (type === 'profile_update') this.outbox = this.outbox.filter((m) => m.type !== 'profile_update');
      this.outbox.push({ type, payload });
      if (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
    }
    return false;
  }

  _flushOutbox() {
    const items = this.outbox.splice(0);
    for (const m of items) {
      if (!this._raw(m)) {
        this.outbox.unshift(...items.slice(items.indexOf(m)));
        break;
      }
    }
  }

  /** AI selector fallback round-trip. Resolves null on timeout / offline. */
  requestSelector({ job_id, step_id, goal, accessibility_tree }) {
    return new Promise((resolve) => {
      if (!this.isConnected()) return resolve(null);
      const key = `${job_id}:${step_id}`;
      const timer = setTimeout(() => {
        this.pendingAi.delete(key);
        resolve(null);
      }, AI_TIMEOUT_MS);
      this.pendingAi.set(key, { resolve, timer });
      const ok = this._raw({ type: 'ai_selector_request', payload: { job_id, step_id, goal, accessibility_tree } });
      if (!ok) {
        clearTimeout(timer);
        this.pendingAi.delete(key);
        resolve(null);
      }
      return undefined;
    });
  }

  sendProfiles() {
    return this.send('profile_update', { profiles: this.pm.forBrain() });
  }
}

module.exports = { BrainClient };
