/* global window, document */
'use strict';

(function main() {
  const api = window.koneqti;
  const page = document.body.dataset.page;
  const $ = (id) => document.getElementById(id);
  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const PLATFORM_NAMES = { instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook', tiktok: 'TikTok', dat: 'DAT', truckstop: 'Truckstop', '123loadboard': '123Loadboard' };
  const ENGINE_NAMES = { chromium_patched: 'Chrome', cloakbrowser: 'CloakBrowser', camoufox: 'Camoufox' };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  document.querySelectorAll('[data-open]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); api.openDashboard(a.dataset.open); });
  });

  // ---------------- login ----------------
  if (page === 'login') {
    api.getStatus().then((r) => { if (r.ok && !r.data.configured) $('config-warning').hidden = false; });
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      $('login-error').textContent = '';
      $('login-btn').disabled = true;
      $('login-btn').textContent = 'Signing in…';
      const r = await api.login($('email').value, $('password').value);
      if (!r.ok) {
        $('login-error').textContent = r.error || 'Login failed';
        $('login-btn').disabled = false;
        $('login-btn').textContent = 'Sign in';
      }
      // On success the main process loads profiles.html.
    });
    return;
  }

  // ---------------- profiles ----------------
  function statusBadge(p) {
    if (p.busy) return el('span', { class: 'badge info', text: 'Running' });
    if (p.attention === 'logged_out') return el('span', { class: 'badge bad', text: 'Logged out' });
    if (p.status === 'restricted') return el('span', { class: 'badge bad', text: 'Restricted' });
    if (p.status === 'paused') return el('span', { class: 'badge warn', text: p.attention ? `Paused (${p.attention})` : 'Paused' });
    if (p.status === 'warming') return el('span', { class: 'badge warn', text: 'Warming up' });
    return el('span', { class: 'badge ok', text: 'Active' });
  }

  function hoursEditor(p) {
    const wh = p.working_hours || { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
    const days = new Set(wh.days || []);
    const start = el('input', { type: 'time', value: wh.start });
    const end = el('input', { type: 'time', value: wh.end });
    const dayWrap = el('div', { class: 'days' });
    const save = async () => {
      const r = await api.setWorkingHours(p.id, { start: start.value, end: end.value, days: [...days].sort() });
      if (!r.ok) window.alert(r.error);
    };
    DAY_LABELS.forEach((label, i) => {
      const b = el('button', { type: 'button', class: days.has(i) ? 'on' : '', text: label, title: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i] });
      b.addEventListener('click', () => {
        if (days.has(i)) days.delete(i); else days.add(i);
        b.classList.toggle('on');
        save();
      });
      dayWrap.appendChild(b);
    });
    start.addEventListener('change', save);
    end.addEventListener('change', save);
    return el('div', { class: 'stack' }, [el('div', { class: 'hours' }, [start, el('span', { class: 'muted', text: '–' }), end]), dayWrap]);
  }

  let lastProfilesKey = '';
  function renderProfiles(profiles) {
    const key = JSON.stringify(profiles);
    if (key === lastProfilesKey) return; // avoid resetting inputs while editing
    lastProfilesKey = key;
    const body = $('profiles-body');
    body.textContent = '';
    if (!profiles.length) {
      body.appendChild(el('tr', {}, [el('td', { colspan: '8', class: 'empty', text: 'No profiles yet — add one, then open its browser to log in.' })]));
      return;
    }
    profiles.forEach((p) => {
      const pct = p.daily_limit ? Math.min(100, Math.round((p.used_today / p.daily_limit) * 100)) : 0;
      const openBtn = el('button', { class: 'btn sm', text: 'Open browser to log in' });
      openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        const r = await api.openProfileBrowser(p.id);
        if (!r.ok) window.alert(r.error);
        openBtn.disabled = false;
      });
      const removeBtn = el('button', { class: 'btn ghost sm', text: 'Remove' });
      removeBtn.addEventListener('click', async () => {
        const r = await api.removeProfile(p.id);
        if (!r.ok) window.alert(r.error);
      });
      body.appendChild(el('tr', {}, [
        el('td', { text: PLATFORM_NAMES[p.platform] || p.platform }),
        el('td', { class: 'mono', text: `@${p.handle}` }),
        el('td', { text: ENGINE_NAMES[p.engine] || p.engine }),
        el('td', {}, [statusBadge(p)]),
        el('td', {}, [
          el('div', { class: 'mono', text: `${p.used_today} / ${p.daily_limit ?? '∞'}` }),
          el('div', { class: 'bar' }, [el('span', { style: `width:${pct}%` })]),
        ]),
        el('td', { text: p.warmup_week >= 4 ? 'Done (100%)' : `Week ${p.warmup_week} (${p.warmup_pct}%)` }),
        el('td', {}, [hoursEditor(p)]),
        el('td', {}, [el('div', { class: 'row' }, [openBtn, removeBtn])]),
      ]));
    });
  }

  function renderStatus(s) {
    if (!s) return;
    $('who').textContent = s.email ? `Signed in as ${s.email}` : 'Signed in';
    $('app-version').textContent = s.app_version || '';
    const b = s.brain || {};
    const dot = $('brain-dot');
    const badge = $('brain-badge');
    if (s.paused_all) {
      dot.className = 'dot warn'; badge.className = 'badge warn'; badge.textContent = 'Paused';
      $('brain-text').textContent = b.connected ? 'Brain connected ✅ — all jobs paused' : 'Paused (offline)';
    } else if (b.connected) {
      dot.className = 'dot ok'; badge.className = 'badge ok'; badge.textContent = 'Connected';
      $('brain-text').textContent = 'Brain connected ✅';
    } else if (b.state === 'connecting') {
      dot.className = 'dot warn'; badge.className = 'badge warn'; badge.textContent = 'Connecting';
      $('brain-text').textContent = 'Connecting to brain…';
    } else {
      dot.className = 'dot bad'; badge.className = 'badge bad'; badge.textContent = 'Offline';
      $('brain-text').textContent = `Offline${b.last_error ? ` — ${b.last_error}` : ''} (retrying automatically)`;
    }
    const r = s.runner || {};
    $('jobs-text').textContent = r.running
      ? `Running ${r.running} job${r.running === 1 ? '' : 's'}${r.queued ? ` · ${r.queued} queued` : ''}`
      : (r.queued ? `${r.queued} queued` : 'No jobs running');
    $('chrome-warning').hidden = Boolean(s.chrome_found);
    $('engines').textContent = (s.engines || []).join(', ') || 'none';
    const st = s.settings || {};
    $('set-paused').checked = Boolean(st.pausedAll);
    $('set-autolaunch').checked = st.autoLaunch !== false;
    $('set-concurrency').value = String(st.concurrency || 1);
    renderProfiles(s.profiles || []);
  }

  $('logout-btn').addEventListener('click', () => api.logout());
  $('set-paused').addEventListener('change', (e) => api.setSettings({ pausedAll: e.target.checked }));
  $('set-autolaunch').addEventListener('change', (e) => api.setSettings({ autoLaunch: e.target.checked }));
  $('set-concurrency').addEventListener('change', (e) => api.setSettings({ concurrency: Number(e.target.value) }));

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('add-error').textContent = '';
    const r = await api.addProfile({
      platform: $('add-platform').value,
      handle: $('add-handle').value,
      engine: $('add-engine').value,
    });
    if (!r.ok) { $('add-error').textContent = r.error; return; }
    $('add-handle').value = '';
    const s = await api.getStatus();
    if (s.ok) renderStatus(s.data);
  });

  api.onStatus(renderStatus);
  api.getStatus().then((r) => { if (r.ok) renderStatus(r.data); });
}());
