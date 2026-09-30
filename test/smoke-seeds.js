'use strict';
/**
 * Runs the brain's SEEDED recipes (supabase/seeds/automation_recipes.sql) against local
 * mock pages, to prove the executor supports every step flag they use
 * (optional, only_if, skip_if_done, human, on_match: abort_blocked, target, until_text,
 * templated times/limit, attr "text", all: true, XPath selectors).
 *
 *   SEEDS_SQL=../Leadskoneqtiapp/supabase/seeds/automation_recipes.sql node test/smoke-seeds.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const SEEDS = process.env.SEEDS_SQL || path.join(__dirname, '..', '..', 'Leadskoneqtiapp', 'supabase', 'seeds', 'automation_recipes.sql');
if (!fs.existsSync(SEEDS)) {
  console.log(`skip seeds smoke test (no ${SEEDS})`);
  process.exit(0);
}
const pwRoot = '/opt/pw-browsers';
if (!process.env.CHROME_PATH && fs.existsSync(pwRoot)) {
  const dir = fs.readdirSync(pwRoot).find((d) => /^chromium-\d+$/.test(d));
  if (dir) process.env.CHROME_PATH = path.join(pwRoot, dir, 'chrome-linux', 'chrome');
}
process.env.KONEQTI_HEADLESS = '1';
process.env.KONEQTI_DELAY_SCALE = '0.01';
process.env.KONEQTI_QUIET = '1';
process.env.KONEQTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-seeds-'));

const { JsonStore } = require('../store');
const { ProfileManager } = require('../profile-manager');
const { BrowserAdapter } = require('../browser/adapter');
const { executeRecipe } = require('../recipe-executor');
const { parseInfo } = require('../jobs/scrape-google-maps');

function loadSeeds() {
  const sql = fs.readFileSync(SEEDS, 'utf8');
  const out = {};
  const re = /VALUES \('([\w]+)', '([\w]+)', (\d+), \$r\$([\s\S]*?)\$r\$/g;
  let m;
  while ((m = re.exec(sql))) out[`${m[1]}/${m[2]}`] = { platform: m[1], action: m[2], version: Number(m[3]), steps: JSON.parse(m[4]) };
  return out;
}

const PAGES = {
  '/li-profile': `<!doctype html><html><body><main>
      <h1 class="text-heading-xlarge">Mike Smith</h1>
      <div class="text-body-medium break-words">Owner at Mike's Plumbing</div>
      <button id="inv" aria-label="Invite Mike Smith to connect" onclick="document.getElementById('dlg').hidden=false">Connect</button>
    </main>
    <div id="dlg" role="dialog" hidden>
      <button aria-label="Add a note" onclick="document.getElementById('ta').hidden=false">Add a note</button>
      <textarea id="ta" name="message" hidden></textarea>
      <button aria-label="Send invitation" onclick="var b=document.getElementById('inv');b.setAttribute('aria-label','Pending, click to withdraw');b.textContent='Pending';document.getElementById('dlg').hidden=true;window.__note=document.getElementById('ta').value">Send</button>
    </div></body></html>`,
  '/ig-profile': `<!doctype html><html><body><header>
      <div role="button" onclick="document.getElementById('box').hidden=false;document.getElementById('box').focus()">Message</div></header>
      <div id="rows" aria-label="Messages in conversation"></div>
      <div id="box" role="textbox" aria-label="Message" contenteditable="true" hidden
        onkeydown="if(event.key==='Enter'){var r=document.createElement('div');r.setAttribute('role','row');r.innerHTML='<div dir=auto></div>';r.firstChild.textContent=this.textContent;document.getElementById('rows').appendChild(r);window.__sent=this.textContent;this.textContent='';event.preventDefault();}"></div>
    </body></html>`,
  '/ig-blocked': '<!doctype html><html><body><h2>Try Again Later</h2><p>We restrict certain activity to protect our community.</p></body></html>',
  '/maps': `<!doctype html><html><body><div role="main">
      <div role="feed" style="height:300px;overflow:auto">
        ${[1, 2, 3].map((i) => `<div class="Nv2PK"><a class="hfpxzc" aria-label="Biz ${i}" href="https://maps.example/place/${i}"></a>
          <span class="MW4etd">4.${i}</span><span class="UY7F9">(${i}2${i})</span>
          <div class="W4Efsd">Plumber · ${i}0 Main St</div><div class="W4Efsd">Open ⋅ Closes 6PM · (214) 555-01${i}0</div>
          ${i === 1 ? '<a data-value="Website" href="https://biz1.example">Website</a>' : ''}</div>`).join('')}
        <div style="height:900px"></div>
        <span>You've reached the end of the list.</span>
      </div></div></body></html>`,
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

function withUrl(recipe, url) {
  const steps = recipe.steps.map((s, i) => (i === 0 && s.action === 'goto' ? { ...s, url } : s));
  return { ...recipe, steps };
}

(async () => {
  const seeds = loadSeeds();
  assert.ok(Object.keys(seeds).length >= 5, 'seed recipes parsed');
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const pm = new ProfileManager({ store: new JsonStore({ dir: process.env.KONEQTI_DATA_DIR, name: 's', defaults: { profiles: [] } }) });
  const adapter = new BrowserAdapter('chromium_patched', { profileManager: pm, headless: true });
  await adapter.launch(pm.ensureWebProfile('chromium_patched', 1));
  const page = await adapter.newPage();
  const noAi = async () => null;
  try {
    // LinkedIn connect WITHOUT note: only_if skips add_note/type_note; skip_if_done skips the More menu.
    let r = await executeRecipe(page, withUrl(seeds['linkedin/connect'], `${base}/li-profile`), { vars: { profile_url: 'x', note: '' }, requestSelector: noAi });
    assert.ok(r.skipped_steps.includes('open_more') && r.skipped_steps.includes('click_connect_menu'), 'skip_if_done');
    assert.ok(r.skipped_steps.includes('add_note') && r.skipped_steps.includes('type_note'), 'only_if empty');
    assert.ok(!r.skipped_steps.includes('verify'), 'Pending verified');
    // WITH note: note typed per-char.
    r = await executeRecipe(page, withUrl(seeds['linkedin/connect'], `${base}/li-profile`), { vars: { note: 'Hi Mike — saw your rating change.' }, requestSelector: noAi });
    assert.strictEqual(await page.evaluate(() => window.__note), 'Hi Mike — saw your rating change.');
    console.log('ok   linkedin/connect seed: only_if + skip_if_done + human typing + optional verify');

    // LinkedIn scrape_profile: attr "text", all: true.
    r = await executeRecipe(page, withUrl(seeds['linkedin/scrape_profile'], `${base}/li-profile`), { vars: {}, requestSelector: noAi });
    assert.strictEqual(r.data.extract.name, 'Mike Smith');
    assert.strictEqual(r.data.extract.headline, "Owner at Mike's Plumbing");
    console.log('ok   linkedin/scrape_profile seed: extract attr "text"');

    // Instagram send_dm: templated url {{handle}}, human type, press Enter, verify.
    r = await executeRecipe(page, withUrl(seeds['instagram/send_dm'], `${base}/ig-profile`), { vars: { handle: 'mike', message: 'Your rating dropped to 3.8' }, requestSelector: noAi });
    assert.strictEqual(await page.evaluate(() => window.__sent), 'Your rating dropped to 3.8');
    console.log('ok   instagram/send_dm seed: type.text + human + press Enter');

    // Instagram blocked → on_match abort_blocked.
    let blockedErr = null;
    try {
      await executeRecipe(page, withUrl(seeds['instagram/send_dm'], `${base}/ig-blocked`), { vars: { handle: 'x', message: 'y' }, requestSelector: noAi });
    } catch (err) { blockedErr = err; }
    assert.ok(blockedErr && blockedErr.blocked === true && blockedErr.failed_step === 'check_blocked', 'abort_blocked');
    assert.deepStrictEqual(blockedErr.warnings, ['captcha_detected']);
    console.log('ok   instagram/send_dm seed: check_text on_match abort_blocked → blocked');

    // Google Maps listing: scroll target + templated times + until_text + templated limit + all: true.
    r = await executeRecipe(page, withUrl(seeds['google_maps/scrape_listing'], `${base}/maps`), { vars: { query: 'plumbers dallas', max_scrolls: '5', limit: '2' }, requestSelector: noAi });
    assert.strictEqual(r.data.extract.length, 2, 'limit from template');
    assert.strictEqual(r.data.extract[0].name, 'Biz 1');
    assert.strictEqual(r.data.extract[0].website, 'https://biz1.example/');
    assert.ok(Array.isArray(r.data.extract[0].info) && r.data.extract[0].info.length === 2, 'all: true');
    const info = parseInfo(r.data.extract[0].info);
    assert.strictEqual(info.category, 'Plumber');
    assert.strictEqual(info.address, '10 Main St');
    assert.ok(info.phone && info.phone.includes('555'));
    console.log('ok   google_maps/scrape_listing seed: scroll target/until_text, templated times+limit, all: true');
    console.log('\nseed recipes smoke test passed');
  } catch (err) {
    console.error('SEEDS SMOKE FAILED:', err);
    process.exitCode = 1;
  } finally {
    await adapter.close();
    srv.close();
    fs.rmSync(process.env.KONEQTI_DATA_DIR, { recursive: true, force: true });
  }
})();
