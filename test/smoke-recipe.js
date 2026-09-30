'use strict';
/**
 * Smoke test (headless): recipe executor + chromium_patched engine + job runner,
 * against a local HTTP server. No network access, no brain needed.
 *
 *   CHROME_PATH=/path/to/chrome node test/smoke-recipe.js
 * (defaults to the Playwright Chromium in /opt/pw-browsers when present)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const pwRoot = '/opt/pw-browsers';
if (!process.env.CHROME_PATH && fs.existsSync(pwRoot)) {
  const dir = fs.readdirSync(pwRoot).find((d) => /^chromium-\d+$/.test(d));
  if (dir) process.env.CHROME_PATH = path.join(pwRoot, dir, 'chrome-linux', 'chrome');
}
process.env.KONEQTI_HEADLESS = '1';
process.env.KONEQTI_DELAY_SCALE = '0.02';
process.env.KONEQTI_QUIET = '1';
process.env.KONEQTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-smoke-'));

const { JsonStore } = require('../store');
const { ProfileManager } = require('../profile-manager');
const { BrowserAdapter } = require('../browser/adapter');
const { executeRecipe } = require('../recipe-executor');
const { JobRunner } = require('../playwright-runner');

const PAGES = {
  '/form': `<!doctype html><html><body>
    <h1>Inbox</h1>
    <input id="msg" aria-label="Message" />
    <button id="send-btn" onclick="document.getElementById('out').textContent='Message sent: '+document.getElementById('msg').value">Send</button>
    <div id="out"></div>
    <input type="file" id="file" onchange="document.getElementById('fname').textContent=this.files[0].name" />
    <div id="fname"></div>
    <div id="panel" style="height:200px;overflow:auto"><div style="height:2000px">tall</div></div>
    <ul id="list">
      <li class="item"><a class="name" href="/p/1">Mike's Plumbing</a><span class="rating">4,3</span><span class="reviews">(1,204)</span><span class="cat">Plumber</span><a class="site" href="https://mikes.example">site</a></li>
      <li class="item"><a class="name" href="/p/2">Sarah's Salon</a><span class="rating">3.8</span><span class="reviews">(87)</span><span class="cat">Hair salon</span></li>
    </ul>
  </body></html>`,
  '/site': `<!doctype html><html lang="en"><head><title>ABC Trucking</title>
    <meta name="description" content="Freight and logistics">
    <script src="https://assets.calendly.com/assets/external/widget.js"></script>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Office Administrator","description":"<p>Manage invoices in Excel and QuickBooks</p>","datePosted":"2026-09-20","hiringOrganization":{"@type":"Organization","name":"ABC Trucking"},"jobLocation":{"@type":"Place","address":{"addressLocality":"Dallas","addressRegion":"TX","addressCountry":"US"}}}</script>
    </head><body><h1>ABC Trucking</h1><p>Call us</p><a href="tel:+1 (214) 555-0100">call</a>
    <a href="/contact">Contact us</a><a href="https://wa.me/12145550100">WhatsApp</a></body></html>`,
  '/contact': '<!doctype html><html><body><p>Email: dispatch@abctrucking.example</p><a href="mailto:owner@abctrucking.example">mail</a></body></html>',
  '/blocked': '<!doctype html><html><body><h2>Try Again Later</h2><p>We restrict certain activity to protect our community.</p></body></html>',
};

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = PAGES[req.url.split('?')[0]];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body || 'not found');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function testExecutor(base, pm) {
  const profile = pm.ensureWebProfile('chromium_patched', 1);
  const adapter = new BrowserAdapter('chromium_patched', { profileManager: pm, headless: true });
  await adapter.launch(profile);
  const page = await adapter.newPage();
  const uploadFile = path.join(process.env.KONEQTI_DATA_DIR, 'note.mp3');
  fs.writeFileSync(uploadFile, 'fake-mp3');
  const aiCalls = [];
  const recipe = {
    id: 'test', version: 3,
    steps: [
      { id: 'open', action: 'goto', url: '{{base}}/form' },
      { id: 'webdriver', action: 'check_text', texts: ['Inbox'] },
      { id: 'type_msg', action: 'type', selectors: ['#does-not-exist', '#msg'], value: '{{message}}' },
      // First selector list fails completely → AI fallback supplies the right one.
      { id: 'click_send', action: 'click', selectors: ['#wrong-send'], goal: 'click the Send button', timeout_ms: 2500 },
      { id: 'confirm', action: 'check_text', texts: ['Message sent: hello {{name}}'] },
      { id: 'upload', action: 'upload_file', selectors: ['#file'], file: '{{file_path}}' },
      { id: 'check_upload', action: 'check_text', selectors: ['#fname'], texts: ['note.mp3'] },
      { id: 'scroll_panel', action: 'scroll', selectors: ['#panel'], times: 2 },
      { id: 'maybe', action: 'click', selectors: ['#nope'], optional: true, timeout_ms: 500 },
      { id: 'pause', action: 'delay', ms: 50 },
      { id: 'press', action: 'press', key: 'Tab' },
      {
        id: 'list', action: 'extract', list_selector: 'li.item', save_as: 'results',
        fields: {
          name: '.name',
          maps_url: { selector: '.name', attr: 'href' },
          rating: '.rating',
          reviews_count: { selector: '.reviews', regex: '([\\d,]+)' },
          category: '.cat',
          website: { selector: '.site', attr: 'href' },
        },
      },
      { id: 'heading', action: 'extract', save_as: 'page', fields: { title: 'h1' } },
      { id: 'shot', action: 'screenshot', name: 'form' },
    ],
  };
  const res = await executeRecipe(page, recipe, {
    vars: { base, message: 'hello {{name}}'.replace('{{name}}', 'Mike'), name: 'Mike', file_path: uploadFile },
    requestSelector: async (req) => { aiCalls.push(req); return '#send-btn'; },
  });
  const webdriver = await page.evaluate(() => navigator.webdriver);
  await adapter.close();

  assert.strictEqual(res.data.results.length, 2, 'extract list');
  assert.strictEqual(res.data.results[0].name, "Mike's Plumbing");
  assert.ok(res.data.results[0].maps_url.endsWith('/p/1'));
  assert.strictEqual(res.data.results[1].website, null);
  assert.strictEqual(res.data.page.title, 'Inbox');
  assert.strictEqual(res.screenshots.length, 1);
  assert.ok(res.screenshots[0].buffer.length > 1000, 'png bytes');
  assert.deepStrictEqual(res.skipped_steps, ['maybe']);
  assert.strictEqual(aiCalls.length, 1, 'ai fallback called once');
  assert.ok(aiCalls[0].accessibility_tree.length > 50 && aiCalls[0].accessibility_tree.length <= 15000);
  assert.deepStrictEqual(res.ai_selectors_used, [{ step_id: 'click_send', selector: '#send-btn' }]);
  assert.ok(webdriver === undefined || webdriver === false, 'navigator.webdriver masked');
  console.log('ok   recipe executor: goto/type/click(+AI fallback)/check_text/upload_file/scroll/optional/delay/press/extract/screenshot');
}

async function testRunner(base, pm) {
  const sent = [];
  const uploads = [];
  const runner = new JobRunner({
    profileManager: pm,
    send: (type, payload) => sent.push({ type, payload }),
    requestSelector: async () => null,
    upload: async (files, meta) => {
      uploads.push({ n: files.length, meta });
      return files.map((f, i) => ({ name: f.name, path: `electron/${meta.job_id}/${i}.png`, url: `https://brain.example/u/${i}.png` }));
    },
    concurrency: 2,
    headless: true,
  });
  const done = new Map();
  runner.on('job_finished', (r) => done.set(r.job_id, r));
  const waitFor = (ids) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ids.every((id) => done.has(id))) { clearInterval(iv); resolve(); }
      if (Date.now() - t0 > 90000) { clearInterval(iv); reject(new Error(`timeout waiting for ${ids.filter((id) => !done.has(id))}`)); }
    }, 100);
  });

  // Social profile with 24/7 working hours for the send test.
  const ig = pm.add({ platform: 'instagram', handle: 'testshop', working_hours: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] } });

  runner.enqueue({
    job_id: 'j-maps', job_type: 'scrape_google_maps', engine: 'chromium_patched',
    recipe: { id: 'r1', version: 7, steps: [
      { id: 'open', action: 'goto', url: `${base}/form?q={{search}}` },
      { id: 'list', action: 'extract', list_selector: 'li.item', save_as: 'results',
        fields: { name: '.name', rating: '.rating', reviews_count: '.reviews', category: '.cat', website: { selector: '.site', attr: 'href' }, maps_url: { selector: '.name', attr: 'href' } } },
    ] },
    payload: { query: 'plumbers', location: 'Dallas, TX', max_results: 10, area_id: 42 },
  });
  runner.enqueue({ job_id: 'j-site', job_type: 'scrape_website', engine: 'chromium_patched', payload: { url: `${base}/site` } });
  runner.enqueue({ job_id: 'j-jobs', job_type: 'scrape_job_posts', payload: { urls: [`${base}/site`], keywords: ['excel'] } });
  runner.enqueue({
    job_id: 'j-proof', job_type: 'capture_proof_screenshots',
    payload: { prospect_id: 'p1', targets: [{ name: 'listing', url: `${base}/form`, selector: '#list' }, { name: 'slide', html: '<h1 style="font:48px sans-serif">Hi Mike</h1>' }] },
  });
  runner.enqueue({
    job_id: 'j-frames', job_type: 'capture_video_frames',
    payload: { prospect_id: 'p1', video_id: 'v1', frames: [{ name: 'title', html: '<body style="background:#6366F1"><h1>Title</h1></body>' }, { name: 'listing', url: `${base}/form` }] },
  });
  runner.enqueue({
    job_id: 'j-dm', job_type: 'send_instagram_dm', profile_id: ig.id,
    recipe: { id: 'r-dm', version: 2, steps: [
      { id: 'open', action: 'goto', url: `${base}/form` },
      { id: 'type', action: 'type', selectors: ['#msg'], value: '{{message}}' },
      { id: 'send', action: 'click', selectors: ['#send-btn'] },
      { id: 'confirm', action: 'check_text', texts: ['Message sent'] },
    ] },
    payload: { handle: '@mikesplumbing', message: 'Your rating dropped from 4.3 to 3.8 this week.' },
  });
  runner.enqueue({
    job_id: 'j-blocked', job_type: 'content_like', platform: 'instagram', profile_id: ig.id,
    recipe: { id: 'r-like', version: 1, steps: [
      { id: 'open', action: 'goto', url: `${base}/blocked` },
      { id: 'like', action: 'click', selectors: ['button[aria-label="Like"]'], timeout_ms: 2500 },
    ] },
    payload: { post_url: `${base}/blocked` },
  });
  runner.enqueue({ job_id: 'j-unknown', job_type: 'teleport', payload: {} });
  runner.enqueue({ job_id: 'j-norecipe', job_type: 'check_gbp', payload: { maps_url: `${base}/form` } });

  await waitFor(['j-maps', 'j-site', 'j-jobs', 'j-proof', 'j-frames', 'j-dm', 'j-blocked', 'j-unknown', 'j-norecipe']);

  const maps = done.get('j-maps');
  assert.strictEqual(maps.status, 'success', JSON.stringify(maps));
  assert.strictEqual(maps.recipe_version, 7);
  assert.strictEqual(maps.data.results.length, 2);
  assert.strictEqual(maps.data.results[0].rating, 4.3);
  assert.strictEqual(maps.data.results[0].reviews_count, 1204);
  assert.strictEqual(maps.data.results[1].no_website, true);
  assert.strictEqual(maps.data.area_id, 42);

  const site = done.get('j-site');
  assert.strictEqual(site.status, 'success', JSON.stringify(site));
  assert.ok(site.data.emails.includes('dispatch@abctrucking.example'));
  assert.ok(site.data.emails.includes('owner@abctrucking.example'));
  assert.ok(site.data.tech.some((t) => t.name === 'calendly'));
  assert.ok(site.data.whatsapp_links.length === 1);
  assert.ok(site.data.phones.includes('+12145550100'));

  const jobs = done.get('j-jobs');
  assert.strictEqual(jobs.status, 'success', JSON.stringify(jobs));
  assert.strictEqual(jobs.data.jobs[0].title, 'Office Administrator');
  assert.strictEqual(jobs.data.jobs[0].company, 'ABC Trucking');

  const proof = done.get('j-proof');
  assert.strictEqual(proof.status, 'success', JSON.stringify(proof));
  assert.strictEqual(proof.data.files.length, 2);
  assert.ok(proof.data.files[0].url);

  const frames = done.get('j-frames');
  assert.strictEqual(frames.status, 'success', JSON.stringify(frames));
  assert.strictEqual(frames.data.frames.length, 2);
  assert.strictEqual(frames.data.width, 1280);
  assert.ok(uploads.some((u) => u.meta.kind === 'video_frame' && u.meta.extra.video_id === 'v1'));

  const dm = done.get('j-dm');
  assert.strictEqual(dm.status, 'success', JSON.stringify(dm));
  assert.strictEqual(dm.data.sent, true);
  assert.strictEqual(pm.usage(pm.get(ig.id)).actions, 1, 'action counted');

  const blocked = done.get('j-blocked');
  assert.strictEqual(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.ok(blocked.warnings.includes('action_blocked'));
  assert.ok(sent.some((m) => m.type === 'account_event' && m.payload.event === 'restricted'));
  assert.strictEqual(pm.get(ig.id).status, 'restricted');

  assert.strictEqual(done.get('j-unknown').status, 'failed');
  assert.strictEqual(done.get('j-norecipe').error, 'recipe_required');

  // Restricted profile → next social job is skipped locally (hard stop).
  runner.enqueue({ job_id: 'j-after', job_type: 'send_instagram_dm', profile_id: ig.id, recipe: { steps: [{ action: 'delay', ms: 1 }] }, payload: { handle: 'x', message: 'y' } });
  await waitFor(['j-after']);
  assert.strictEqual(done.get('j-after').status, 'skipped');

  // Duplicate job id → result re-sent, not re-run.
  const before = sent.filter((m) => m.type === 'job_result' && m.payload.job_id === 'j-dm').length;
  runner.enqueue({ job_id: 'j-dm', job_type: 'send_instagram_dm', payload: {} });
  const after = sent.filter((m) => m.type === 'job_result' && m.payload.job_id === 'j-dm').length;
  assert.strictEqual(after, before + 1);

  assert.ok(sent.some((m) => m.type === 'job_progress'));
  console.log('ok   runner: maps, website, job posts (JSON-LD), proof screenshots, video frames, DM send, block detection, limits, dedupe');
}

function testLimits(pm) {
  const li = pm.add({ platform: 'linkedin', handle: 'limits-test' });
  assert.strictEqual(pm.dailyLimit(li, 'actions'), 5, 'week1 = 25% of 20');
  pm.setBrainLimits({ linkedin: 12 });
  assert.strictEqual(pm.dailyLimit(li, 'actions'), 3, 'brain limit lower wins');
  pm.setBrainLimits({});
  const old = { ...li, warmup_started_at: new Date(Date.now() - 30 * 86400e3).toISOString() };
  assert.strictEqual(pm.dailyLimit(old, 'actions'), 20, 'week4+ = 100%');
  const fb = { ...old, platform: 'facebook' };
  assert.strictEqual(pm.dailyLimit(fb, 'actions'), 15);
  for (let i = 0; i < 5; i += 1) pm.increment(li.id, 'actions');
  assert.strictEqual(pm.canRun(pm.get(li.id), 'actions').ok, false, 'hard stop at limit');
  const closed = { ...li, working_hours: { start: '09:00', end: '09:01', days: [] } };
  assert.strictEqual(pm.sessionWindow(closed).allowed, false);
  assert.strictEqual(li.fingerprint_seed.length, 32);
  console.log('ok   profile limits: warmup 25/50/75/100, brain limit, hard stop, working hours');
}

(async () => {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const store = new JsonStore({ dir: process.env.KONEQTI_DATA_DIR, name: 'smoke', defaults: { profiles: [] } });
  const pm = new ProfileManager({ store });
  try {
    testLimits(pm);
    await testExecutor(base, pm);
    await testRunner(base, pm);
    console.log('\nsmoke test passed');
    process.exitCode = 0;
  } catch (err) {
    console.error('SMOKE FAILED:', err);
    process.exitCode = 1;
  } finally {
    srv.close();
    fs.rmSync(process.env.KONEQTI_DATA_DIR, { recursive: true, force: true });
  }
})();
