'use strict';
/**
 * Uploads screenshots / video frames to the brain:
 *   POST {BRAIN_HTTP_URL}/api/electron/uploads   (multipart/form-data)
 *   Headers: Authorization: Bearer <supabase access_token>, X-Electron-Secret: <ELECTRON_SECRET>
 *   Fields:  files (one part per file), kind, prospect_id, job_id, names (JSON array)
 *   Response: { ok: true, data: { files: [{ name, path, url }] } }
 *
 * Uses Node 20 global fetch/FormData/Blob. No Electron imports.
 */

/**
 * @param {object} cfg
 * @param {string} cfg.brainHttpUrl
 * @param {string} cfg.electronSecret
 * @param {() => Promise<string|null>} cfg.getAccessToken
 */
function createUploader(cfg) {
  return async function upload({ files, kind = 'proof', prospect_id = null, job_id = null, extra = {} }) {
    if (!Array.isArray(files) || !files.length) return [];
    if (!cfg.brainHttpUrl) throw new Error('upload_not_configured');
    const token = await cfg.getAccessToken();
    if (!token) throw new Error('upload_not_authenticated');

    const form = new FormData();
    form.append('kind', String(kind));
    if (prospect_id) form.append('prospect_id', String(prospect_id));
    if (job_id) form.append('job_id', String(job_id));
    for (const [k, v] of Object.entries(extra || {})) {
      if (v !== undefined && v !== null) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    form.append('names', JSON.stringify(files.map((f) => f.name)));
    for (const f of files) {
      const type = f.contentType || 'image/png';
      const ext = type === 'image/jpeg' ? 'jpg' : type.split('/')[1] || 'bin';
      const filename = /\.[a-z0-9]+$/i.test(f.name) ? f.name : `${f.name}.${ext}`;
      form.append('files', new Blob([f.buffer], { type }), filename.replace(/[^\w.-]/g, '_'));
    }

    const url = `${cfg.brainHttpUrl.replace(/\/+$/, '')}/api/electron/uploads`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 60000);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Electron-Secret': cfg.electronSecret || '',
          },
          body: form,
          signal: controller.signal,
        });
        clearTimeout(t);
        let body = null;
        try { body = await res.json(); } catch (_) { body = null; }
        if (!res.ok || !body || body.ok === false) {
          const msg = (body && body.error) || `upload_http_${res.status}`;
          if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(msg), { fatal: true });
          throw new Error(msg);
        }
        const data = body.data || {};
        const list = Array.isArray(data) ? data : data.files || [];
        return list.map((x, i) => ({
          name: x.name || files[i]?.name,
          path: x.path || null,
          url: x.url || null,
        }));
      } catch (err) {
        lastErr = err;
        if (err.fatal) break;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr || new Error('upload_failed');
  };
}

module.exports = { createUploader };

/**
 * Download helper: adds brain auth headers only when the URL points at the brain
 * (e.g. voice-note mp3s served by the brain). Other URLs are fetched plainly.
 */
function createDownloader(cfg) {
  return async function download(url) {
    const headers = {};
    try {
      const target = new URL(url);
      const brain = cfg.brainHttpUrl ? new URL(cfg.brainHttpUrl) : null;
      if (brain && target.host === brain.host) {
        const token = await cfg.getAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        headers['X-Electron-Secret'] = cfg.electronSecret || '';
      }
    } catch (_) { /* invalid url → fetch will throw */ }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 60000);
    try {
      return await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  };
}

module.exports.createDownloader = createDownloader;
