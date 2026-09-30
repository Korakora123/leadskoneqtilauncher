'use strict';
/**
 * capture_proof_screenshots (Agent 11 proof — LOAD RULES: screenshots run on Electron, not brain).
 * payload: {
 *   prospect_id, kind?: 'proof',
 *   targets: [{ name, url?, html?, selector?, full_page?, wait_ms?, width?, height? }]
 * }
 * recipe: optional — run on each target page (var `target_url`, `target_name`), e.g. to dismiss consent dialogs.
 * Uploads PNGs to brain /api/electron/uploads (fields: files, kind, prospect_id, job_id).
 */
const { JobError, clean } = require('./_helpers');

async function captureTarget(ctx, page, t, i) {
  const name = clean(t.name, 80) || `shot_${i + 1}`;
  const width = Number(t.width) || 1280;
  const height = Number(t.height) || 800;
  await page.setViewportSize({ width, height });
  if (t.html) {
    await page.setContent(String(t.html), { waitUntil: 'load', timeout: 30000 });
  } else if (t.url) {
    await page.goto(String(t.url), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await ctx.behavior.humanDelay(1200, 2500, ctx.signal);
    if (ctx.job.recipe && Array.isArray(ctx.job.recipe.steps) && ctx.job.recipe.steps.length) {
      await ctx.runRecipe({ target_url: t.url, target_name: name }).catch(() => null);
    }
  } else {
    throw new JobError('target_missing_url_or_html');
  }
  if (t.wait_ms) await ctx.behavior.sleep(Math.min(15000, Number(t.wait_ms)), ctx.signal);
  let buffer = null;
  if (t.selector) {
    const loc = page.locator(String(t.selector)).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: 8000 });
      buffer = await loc.screenshot({ type: 'png' });
    } catch (_) {
      buffer = null; // fall back to viewport
    }
  }
  if (!buffer) buffer = await page.screenshot({ type: 'png', fullPage: Boolean(t.full_page) });
  return { name, buffer, contentType: 'image/png', source_url: t.url || null, width, height };
}

module.exports = {
  type: 'capture_proof_screenshots',
  platform: 'web',
  category: 'none',
  captureTarget,
  async run(ctx) {
    const { payload, page } = ctx;
    const targets = (Array.isArray(payload.targets) ? payload.targets : []).slice(0, 12);
    if (!targets.length) throw new JobError('missing_payload_fields:targets');
    const shots = [];
    const failed = [];
    for (let i = 0; i < targets.length; i += 1) {
      ctx.progress(`target_${i + 1}`, `capture ${i + 1}/${targets.length}`);
      try {
        shots.push(await captureTarget(ctx, page, targets[i], i));
      } catch (err) {
        if (err && err.message === 'cancelled') throw err;
        failed.push({ name: targets[i].name || `shot_${i + 1}`, error: err.message });
      }
    }
    if (!shots.length) throw new JobError(failed[0] ? failed[0].error : 'no_screenshots');
    ctx.progress('upload', `uploading ${shots.length} file(s)`);
    const uploaded = await ctx.upload(shots, { kind: payload.kind || 'proof', prospect_id: payload.prospect_id || null });
    return {
      data: {
        prospect_id: payload.prospect_id || null,
        files: shots.map((s, i) => ({
          name: s.name,
          source_url: s.source_url,
          width: s.width,
          height: s.height,
          url: uploaded[i] ? uploaded[i].url : null,
          path: uploaded[i] ? uploaded[i].path : null,
        })),
        failed,
      },
    };
  },
};
