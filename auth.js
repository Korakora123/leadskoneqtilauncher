'use strict';
/**
 * Supabase email + password login for the launcher.
 * The session is persisted in the app store (encrypted via OS keychain when
 * Electron safeStorage is available). No API keys are ever stored — only the
 * user's own Supabase session (anon key comes from config).
 */
const { createClient } = require('@supabase/supabase-js');
const { createLogger } = require('./logger');

const log = createLogger('auth');

function storageAdapter(store) {
  const k = (key) => `secrets.${String(key).replace(/[^\w-]/g, '_')}`;
  return {
    getItem: (key) => store.getSecret(k(key)),
    setItem: (key, value) => { store.setSecret(k(key), value); },
    removeItem: (key) => { store.delete(k(key)); },
  };
}

class Auth {
  /**
   * @param {object} o
   * @param {import('./store').JsonStore} o.store
   * @param {string} o.supabaseUrl
   * @param {string} o.anonKey
   */
  constructor({ store, supabaseUrl, anonKey }) {
    this.store = store;
    this.configured = Boolean(supabaseUrl && anonKey);
    this.client = null;
    if (this.configured) {
      try {
        this.client = createClient(supabaseUrl, anonKey, {
          auth: {
            storage: storageAdapter(store),
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storageKey: 'koneqti-leads-auth',
          },
        });
      } catch (err) {
        log.error('supabase client init failed', { err: err.message });
        this.configured = false;
      }
    }
  }

  async login(email, password) {
    if (!this.client) return { ok: false, error: 'Launcher is not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing).' };
    try {
      const { data, error } = await this.client.auth.signInWithPassword({ email: String(email || '').trim(), password: String(password || '') });
      if (error) return { ok: false, error: error.message };
      log.info('logged in', { user_id: data.user && data.user.id });
      return { ok: true, user: { id: data.user.id, email: data.user.email } };
    } catch (err) {
      return { ok: false, error: err.message || 'Login failed' };
    }
  }

  async logout() {
    try {
      if (this.client) await this.client.auth.signOut({ scope: 'local' });
    } catch (_) { /* ignore */ }
    try { this.store.delete('secrets'); } catch (_) { /* ignore */ }
    return { ok: true };
  }

  async getSession() {
    if (!this.client) return null;
    try {
      const { data } = await this.client.auth.getSession();
      return data && data.session ? data.session : null;
    } catch (_) {
      return null;
    }
  }

  async getUser() {
    const s = await this.getSession();
    return s && s.user ? { id: s.user.id, email: s.user.email } : null;
  }

  /** Access token, refreshed if it expires within 2 minutes. */
  async getAccessToken() {
    const s = await this.getSession();
    if (!s) return null;
    const expiresAt = (s.expires_at || 0) * 1000;
    if (expiresAt && expiresAt - Date.now() < 120000) {
      const refreshed = await this.refresh();
      return refreshed ? refreshed.access_token : null;
    }
    return s.access_token;
  }

  /** Force a refresh (called before reconnecting to the brain). */
  async refresh() {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client.auth.refreshSession();
      if (error) {
        log.warn('session refresh failed', { err: error.message });
        return null;
      }
      return data.session || null;
    } catch (err) {
      log.warn('session refresh error', { err: err.message });
      return null;
    }
  }
}

module.exports = { Auth };
