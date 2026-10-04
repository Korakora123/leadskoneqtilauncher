'use strict';
/**
 * Smoke test (headless): Dispatch OS `search_load_board` job.
 *
 * Runs the SEEDED board recipes (Leadskoneqtiapp/supabase/seeds/dispatch_recipes.sql) through the
 * REAL JobRunner → jobs/search-load-board.js → recipe executor, in headless Chromium, against mock
 * board pages served by a local HTTP server. Recipe goto URLs are rewritten to the local server
 * (https://one.dat.com/… → http://127.0.0.1:PORT/dat/…), everything else in the recipe is unchanged.
 *
 * Asserts: normalized contract rows, max_results cap + dedupe, template vars reaching the form,
 * fallback selectors, login wall → blocked/logged_out (+ profile paused), captcha → blocked,
 * daily limit (40/day, no warmup, brain can lower), 45-90 s pacing between searches, nothing
 * written to the launcher store.
 *
 *   node test/smoke-load-board.js       (SEEDS_SQL=… to override the seed file path)
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
process.env.KONEQTI_DELAY_SCALE = '0.01';
process.env.KONEQTI_QUIET = '1';
process.env.KONEQTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-board-'));

const SEEDS = process.env.SEEDS_SQL || path.join(__dirname, '..', '..', 'Leadskoneqtiapp', 'supabase', 'seeds', 'dispatch_recipes.sql');

const { JsonStore } = require('../store');
const { ProfileManager, localDateKey } = require('../profile-manager');
const { JobRunner } = require('../playwright-runner');
const board = require('../jobs/search-load-board');

function loadSeeds() {
  const sql = fs.readFileSync(SEEDS, 'utf8');
  const out = {};
  const re = /VALUES \('([\w]+)', '([\w]+)', (\d+), \$r\$([\s\S]*?)\$r\$::jsonb, '(\w+)'\)/g;
  let m;
  while ((m = re.exec(sql))) {
    out[`${m[1]}/${m[2]}`] = { id: `${m[1]}/${m[2]}`, version: Number(m[3]), steps: JSON.parse(m[4]), status: m[5] };
  }
  return out;
}

// ---------------- mock boards ----------------
const state = { loggedIn: { dat: true, truckstop: true, '123': true }, captcha123: false, log: [] };

const SEARCH_JS = (boardKey, sel) => `<script>
  function v(s){var e=document.querySelector(s);return e?e.value:'';}
  function show(id){document.getElementById(id).hidden=false;}
  function pick(input,list,el){document.querySelector(input).value=el.textContent.trim();document.getElementById(list).hidden=true;}
  function runSearch(){
    var q=new URLSearchParams({board:'${boardKey}',origin:v('${sel.origin}'),radius:v('${sel.radius}'),equipment:v('${sel.equipment}'),date:v('${sel.date}')});
    fetch('/log?'+q.toString()).then(function(){
      setTimeout(function(){document.getElementById('results').innerHTML=document.getElementById('rows').innerHTML;},300);
    });
  }
</script>`;

const DAT_ROW = (ref, age, pickup, eq, o, d, trip, company, weight, rate) => `<div data-test="load-row">
  ${ref ? `<span data-test="load-reference">${ref}</span>` : ''}
  <span data-test="load-age-cell">${age}</span><span data-test="load-pickup-date-cell">${pickup}</span>
  <span data-test="load-equipment-cell">${eq}</span><span data-test="load-origin-cell">${o}</span>
  <span data-test="load-destination-cell">${d}</span><span data-test="load-trip-cell">${trip}</span>
  <div data-test="load-company-cell">${company}</div>
  <span data-test="load-weight-cell">${weight}</span><span data-test="load-rate-cell">${rate}</span></div>`;

const DAT_SEARCH = `<!doctype html><html><head><title>DAT One — Search Loads</title></head><body>
  <header>DAT One · <a href="#">Log out</a></header>
  <form onsubmit="return false">
    <button type="button" data-test="new-search-button">New Search</button>
    <input formcontrolname="origin" placeholder="Origin" oninput="show('olist')">
    <div role="listbox" id="olist" hidden><mat-option role="option" onclick="pick('input[formcontrolname=origin]','olist',this)">Dallas, TX</mat-option></div>
    <input formcontrolname="originDeadhead" placeholder="DH-O" value="50">
    <input formcontrolname="equipmentTypes" placeholder="Equipment" oninput="show('elist')">
    <div role="listbox" id="elist" hidden>
      <mat-option role="option" onclick="pick('input[formcontrolname=equipmentTypes]','elist',this)">Van</mat-option>
      <mat-option role="option" onclick="pick('input[formcontrolname=equipmentTypes]','elist',this)">Reefer</mat-option></div>
    <input formcontrolname="pickupDates" placeholder="Date">
    <button type="button" data-test="search-button" onclick="runSearch()">Search</button>
  </form>
  <div id="results"></div>
  <template id="rows">
    ${DAT_ROW('DAT-1001', '00:12', '10/06', 'V', 'Dallas, TX (32)', 'Atlanta, GA', '781 mi',
    '<span class="company-name">Acme Logistics</span> <span data-test="load-company-mc">MC# 123456</span>', '42,000 lbs', '$2,450')}
    ${DAT_ROW('DAT-1002', '5m', '10/06 - 10/07', 'Van', 'Fort Worth, TX 76102', 'Memphis, TN', '1,234 mi',
    'Big Freight LLC MC-0987654 (214) 555-0100', '38K lbs', '$2.15/mi')}
    ${DAT_ROW('', '2h', 'Oct 7', 'Reefer', 'Houston, TX', 'Chicago, IL', '1,082 mi', '<span class="company-name">Cold Chain Co</span>', '', '—')}
    ${DAT_ROW('DAT-1001', '00:12', '10/06', 'V', 'Dallas, TX (32)', 'Atlanta, GA', '781 mi', 'Acme Logistics', '42,000 lbs', '$2,450')}
    <div data-test="load-row"><span>Sponsored: get factoring today</span></div>
    ${DAT_ROW('DAT-1005', '1d', '10/08', 'F', 'Waco, TX', 'Denver, CO', '836 mi',
    '<span class="company-name">Peak Brokerage</span><span data-test="load-company-mc">MC 765432</span>', '21 tons', '$3,100.50')}
  </template>
  ${SEARCH_JS('dat', { origin: 'input[formcontrolname=origin]', radius: 'input[formcontrolname=originDeadhead]', equipment: 'input[formcontrolname=equipmentTypes]', date: 'input[formcontrolname=pickupDates]' })}
</body></html>`;

// Truckstop mock deliberately uses the SECOND / later selector of each step (fallback coverage).
const TS_SEARCH = `<!doctype html><html><head><title>Truckstop — Loads</title></head><body>
  <form onsubmit="return false">
    <input aria-label="Origin"><input aria-label="Radius (mi)"><input placeholder="Equipment">
    <input aria-label="Pickup date"><button type="button" onclick="runSearch()">Search</button>
  </form>
  <div id="results"></div>
  <template id="rows"><table class="load-results-table"><thead><tr><th>Age</th><th>Origin</th></tr></thead><tbody>
    <tr><td class="load-id">TS-77</td><td class="age">12 min ago</td><td class="pickup">10/06/2026</td><td class="equipment">Reefer</td>
      <td class="origin">Dallas, TX</td><td class="destination">Phoenix, AZ 85001</td><td class="trip">1,065</td>
      <td class="company">Desert Freight Inc</td><td class="mc">123987</td><td class="weight">40,000</td><td class="rate">$2,900.00</td></tr>
    <tr><td class="load-id">TS-78</td><td class="age">1h</td><td class="pickup">10/07/2026</td><td class="equipment">Van</td>
      <td class="origin">Irving, TX</td><td class="destination">Tulsa, OK</td><td class="trip">270 mi</td>
      <td class="company">North Star Logistics MC#555444</td><td class="mc"></td><td class="weight">12K</td><td class="rate"></td></tr>
  </tbody></table></template>
  ${SEARCH_JS('truckstop', { origin: 'input[aria-label=Origin]', radius: 'input[aria-label="Radius (mi)"]', equipment: 'input[placeholder=Equipment]', date: 'input[aria-label="Pickup date"]' })}
</body></html>`;

const L123_SEARCH = `<!doctype html><html><head><title>123Loadboard</title></head><body>
  <form onsubmit="return false">
    <input name="origin" placeholder="Origin"><input name="originRadius"><input name="equipment" placeholder="Equipment">
    <input name="pickupDate"><button type="button" data-test="search-loads" onclick="runSearch()">Search</button>
  </form>
  <div id="results"></div>
  <template id="rows">
    <div class="load-item"><span class="load-number">123-9001</span><span class="load-age">3m</span><span class="load-pickup">10/06</span>
      <span class="load-equipment">Flatbed</span><span class="load-origin">Austin, TX</span><span class="load-destination">Nashville, TN</span>
      <span class="load-miles">880 mi</span><span class="load-company-name">Volunteer Freight</span><span class="load-company-mc">MC #246810</span>
      <span class="load-weight">45,000 lbs</span><span class="load-rate">$2,640</span></div>
  </template>
  ${SEARCH_JS('123', { origin: 'input[name=origin]', radius: 'input[name=originRadius]', equipment: 'input[name=equipment]', date: 'input[name=pickupDate]' })}
</body></html>`;

const LOGIN = (name) => `<!doctype html><html><body><h1>Log in to ${name}</h1><input name="username" placeholder="Email">
  <input type="password"><a href="#">Forgot password?</a><button>Log in</button></body></html>`;
const CAPTCHA = '<!doctype html><html><body><h2>Please verify you are human</h2><iframe title="captcha challenge" src="about:blank"></iframe></body></html>';

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
      const redirect = (to) => { res.writeHead(302, { location: to }); res.end(); };
      if (u.pathname === '/log') {
        state.log.push(Object.fromEntries(u.searchParams));
        res.writeHead(204); res.end(); return;
      }
      if (u.pathname === '/dat/search-loads-ow') return state.loggedIn.dat ? html(200, DAT_SEARCH) : redirect('/dat/login');
      if (u.pathname === '/dat/login') return html(200, LOGIN('DAT'));
      if (u.pathname === '/truckstop/app/search/loads') return state.loggedIn.truckstop ? html(200, TS_SEARCH) : redirect('/truckstop/login');
      if (u.pathname === '/123/loads/search') {
        if (state.captcha123) return html(200, CAPTCHA);
        return state.loggedIn['123'] ? html(200, L123_SEARCH) : redirect('/123/login');
      }
      return html(404, '<html><body>not found</body></html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function rewrite(recipe, base) {
  const map = [
    ['https://one.dat.com', `${base}/dat`],
    ['https://main.truckstop.com', `${base}/truckstop`],
    ['https://members.123loadboard.com', `${base}/123`],
  ];
  const steps = recipe.steps.map((s) => {
    if (s.action !== 'goto') return s;
    let url = s.url;
    for (const [from, to] of map) url = url.replace(from, to);
    return { ...s, url };
  });
  return { ...recipe, steps };
}

// ---------------- unit checks (pure normalizers) ----------------
function unitChecks() {
  assert.strictEqual(board.parseMoneyCents('$2,450'), 245000);
  assert.strictEqual(board.parseMoneyCents('$2,450.50'), 245050);
  assert.strictEqual(board.parseMoneyCents('—'), null);
  assert.strictEqual(board.parseMoneyCents('$2.15/mi'), null);
  assert.strictEqual(board.parsePerMileCents('$2.15/mi'), 215);
  assert.strictEqual(board.parseMiles('1,234 mi'), 1234);
  assert.strictEqual(board.parseWeightLbs('42K lbs'), 42000);
  assert.strictEqual(board.parseMc('MC# 123456'), '123456');
  assert.strictEqual(board.parseMc('Acme Logistics'), null);
  assert.deepStrictEqual(board.parseLocation('Dallas, TX (32)'), { city: 'Dallas', state: 'TX', zip: null });
  assert.deepStrictEqual(board.parseLocation('75201'), { city: null, state: null, zip: '75201' });
  assert.strictEqual(board.parsePickup('12/30', new Date(2027, 0, 2)), '2026-12-30', 'year inferred across new year');
  assert.strictEqual(board.parsePosted('00:45', Date.parse('2026-10-04T12:00:00Z')), '2026-10-04T11:15:00.000Z');
  assert.strictEqual(board.parsePosted('12 min ago', Date.parse('2026-10-04T12:00:00Z')), '2026-10-04T11:48:00.000Z');
  assert.strictEqual(board.parsePosted('2h', Date.parse('2026-10-04T12:00:00Z')), '2026-10-04T10:00:00.000Z');
  assert.deepStrictEqual(['V', 'Van', 'dry_van', 'R', 'Flatbed', 'power only'].map(board.normalizeEquipment),
    ['dry_van', 'dry_van', 'dry_van', 'reefer', 'flatbed', 'power_only']);
  const v = board.buildVars({ origin: { city: 'Dallas', state: 'tx' }, equipment: 'reefer', pickup_date: '2026-10-06', max_results: 500 }, 'dat');
  assert.strictEqual(v.max_results, 50, 'max_results capped at 50');
  assert.strictEqual(v.equipment_label, 'Reefer');
  assert.strictEqual(v.equipment_code, 'R');
  assert.strictEqual(v.pickup_date_us, '10/06/2026');
  assert.strictEqual(v.origin_query, 'Dallas, TX');
  assert.strictEqual(v.radius_mi, 100, 'default radius');
  console.log('ok   normalizers: money→cents, per-mile, miles, weight, MC digits, locations, dates, equipment, vars');
}

(async () => {
  unitChecks();
  const seeds = loadSeeds();
  for (const b of ['dat', 'truckstop', '123loadboard']) {
    const r = seeds[`${b}/search_loads`];
    assert.ok(r, `seed ${b}/search_loads missing`);
    assert.strictEqual(r.version, 1);
    assert.strictEqual(r.status, 'active');
    const ids = r.steps.map((s) => s.id);
    assert.ok(ids.includes('check_logged_out') && ids.includes('check_captcha') && ids.includes('extract'), `${b} guard/extract steps`);
    const ex = r.steps.find((s) => s.id === 'extract');
    assert.ok(ex.list_selector && ex.save_as === 'loads');
    assert.deepStrictEqual(Object.keys(ex.fields).sort(),
      ['broker_mc', 'broker_name', 'destination', 'equipment', 'external_ref', 'miles', 'origin', 'pickup', 'posted', 'rate', 'weight']);
    assert.strictEqual(r.steps.find((s) => s.id === 'check_logged_out').warning, 'logged_out');
  }
  console.log('ok   seeds: dat / truckstop / 123loadboard search_loads v1 active, guards + extract fields');

  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const store = new JsonStore({ dir: process.env.KONEQTI_DATA_DIR, name: 's', defaults: { profiles: [] } });
  const pm = new ProfileManager({ store });
  const allHours = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
  const dat = pm.add({ platform: 'dat', handle: 'dispatch@example.com', working_hours: allHours });
  const ts = pm.add({ platform: 'truckstop', handle: 'dispatch@example.com', working_hours: allHours });
  const l123 = pm.add({ platform: '123loadboard', handle: 'dispatch@example.com', working_hours: allHours });

  // Limits: 40/day from day one (no warmup); brain can only lower.
  assert.strictEqual(pm.dailyLimit(dat, 'actions'), 40);
  assert.strictEqual(pm.statusOf(dat), 'active', 'board profiles are not "warming"');
  pm.setBrainLimits({ dat: 10 });
  assert.strictEqual(pm.dailyLimit(dat, 'actions'), 10);
  pm.setBrainLimits({ dat: 500 });
  assert.strictEqual(pm.dailyLimit(dat, 'actions'), 40);
  pm.setBrainLimits({});
  console.log('ok   limits: board profiles 40 searches/day, no warmup, brain limit can only lower');

  // Make pacing observable in a fast test: 300-400 s × 0.01 scale = 3-4 s gap.
  board.PACING.min_ms = 300000;
  board.PACING.max_ms = 400000;

  const sent = [];
  const runner = new JobRunner({ profileManager: pm, send: (type, payload) => sent.push({ type, payload }), requestSelector: async () => null, concurrency: 1, headless: true });
  const done = new Map();
  runner.on('job_finished', (r) => done.set(r.job_id, r));
  const waitFor = (ids, ms = 240000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ids.every((id) => done.has(id))) { clearInterval(iv); resolve(); }
      if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${ids.filter((id) => !done.has(id))}`)); }
    }, 100);
  });
  const job = (id, b, payload, recipeKey = `${b}/search_loads`) => ({
    job_id: id, job_type: 'search_load_board',
    recipe: seeds[recipeKey] ? rewrite(seeds[recipeKey], base) : undefined,
    payload: { board: b, ...payload },
  });
  const basePayload = { origin: { city: 'Dallas', state: 'TX', zip: '75201' }, radius_mi: 150, equipment: 'dry_van', pickup_date: '2026-10-06' };

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('ok  ', name); } catch (e) { failures += 1; console.log('FAIL', name, '\n', (e && e.stack) || e); }
  };

  try {
    runner.enqueue(job('dat-1', 'dat', { ...basePayload, max_results: 10 }));
    runner.enqueue(job('dat-2', 'dat', { ...basePayload, max_results: 2 }));
    await waitFor(['dat-1', 'dat-2']);

    await check('dat: seeded recipe via runner → normalized contract rows (dedupe, junk row dropped)', async () => {
      const r = done.get('dat-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.recipe_version, 1);
      const d = r.data;
      assert.strictEqual(d.board, 'dat');
      assert.strictEqual(d.count, 4, JSON.stringify(d.loads, null, 1));
      assert.deepStrictEqual(d.origin, { city: 'Dallas', state: 'TX', zip: '75201' });
      assert.strictEqual(d.equipment, 'dry_van');
      const [a, b, c, e] = d.loads;
      assert.deepStrictEqual(Object.keys(a), ['external_ref', 'broker_name', 'broker_mc', 'origin', 'destination', 'pickup_at',
        'equipment', 'weight_lbs', 'miles', 'rate_cents', 'rate_per_mile_cents', 'posted_at']);
      assert.deepStrictEqual(a, {
        external_ref: 'DAT-1001', broker_name: 'Acme Logistics', broker_mc: '123456',
        origin: { city: 'Dallas', state: 'TX', zip: null }, destination: { city: 'Atlanta', state: 'GA', zip: null },
        pickup_at: '2026-10-06', equipment: 'dry_van', weight_lbs: 42000, miles: 781, rate_cents: 245000, rate_per_mile_cents: null,
        posted_at: a.posted_at,
      });
      assert.ok(Math.abs(Date.parse(a.posted_at) - (Date.now() - 12 * 60e3)) < 5 * 60e3, 'age 00:12 → ~12 min ago');
      assert.strictEqual(b.broker_name, 'Big Freight LLC');
      assert.strictEqual(b.broker_mc, '0987654');
      assert.deepStrictEqual(b.origin, { city: 'Fort Worth', state: 'TX', zip: '76102' });
      assert.strictEqual(b.pickup_at, '2026-10-06');
      assert.strictEqual(b.miles, 1234);
      assert.strictEqual(b.weight_lbs, 38000);
      assert.strictEqual(b.rate_cents, null);
      assert.strictEqual(b.rate_per_mile_cents, 215);
      assert.ok(/^h_[0-9a-f]{16}$/.test(c.external_ref), 'missing ref → stable hash');
      assert.strictEqual(c.equipment, 'reefer');
      assert.strictEqual(c.pickup_at, '2026-10-07');
      assert.strictEqual(c.rate_cents, null);
      assert.strictEqual(c.broker_mc, null);
      assert.strictEqual(c.weight_lbs, null);
      assert.strictEqual(e.equipment, 'flatbed');
      assert.strictEqual(e.rate_cents, 310050);
      assert.strictEqual(e.weight_lbs, 42000);
      assert.strictEqual(e.broker_mc, '765432');
      assert.strictEqual(d._meta.raw_rows, 6);
      assert.strictEqual(d._meta.truncated, false);
      assert.strictEqual(d._meta.paced_ms, 0, 'first search not delayed');
      assert.strictEqual(d._meta.engine, 'chromium_patched', 'runner _meta merged');
      assert.strictEqual(d._meta.profile_id, dat.id);
    });

    await check('dat: template vars reach the board form (origin pick, radius, equipment label, US date)', async () => {
      const entry = state.log.find((x) => x.board === 'dat');
      assert.deepStrictEqual(entry, { board: 'dat', origin: 'Dallas, TX', radius: '150', equipment: 'Van', date: '10/06/2026' });
    });

    await check('dat: max_results cap + truncated + 45-90 s pacing between searches on the same profile', async () => {
      const r = done.get('dat-2');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.data.loads.length, 2);
      assert.strictEqual(r.data._meta.truncated, true);
      assert.ok(r.data._meta.paced_ms > 0 && r.data._meta.paced_ms <= 4000, `paced_ms=${r.data._meta.paced_ms}`);
      assert.ok(sent.some((m) => m.type === 'job_progress' && m.payload.job_id === 'dat-2' && m.payload.step === 'pacing'));
      assert.strictEqual(pm.usage(pm.get(dat.id)).actions, 2, 'each search counts toward the daily limit');
    });

    board.PACING.min_ms = 45000; // back to real values (× 0.01 scale)
    board.PACING.max_ms = 90000;

    runner.enqueue(job('ts-1', 'truckstop', { ...basePayload, equipment: 'reefer', origin: 'Dallas, TX', max_results: 25 }));
    runner.enqueue(job('l123-1', '123loadboard', { ...basePayload, equipment: 'F' }));
    await waitFor(['ts-1', 'l123-1']);

    await check('truckstop: fallback selectors (form + table) → normalized rows', async () => {
      const r = done.get('ts-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.data.count, 2);
      const [a, b] = r.data.loads;
      assert.strictEqual(a.external_ref, 'TS-77');
      assert.strictEqual(a.broker_name, 'Desert Freight Inc');
      assert.strictEqual(a.broker_mc, '123987');
      assert.deepStrictEqual(a.destination, { city: 'Phoenix', state: 'AZ', zip: '85001' });
      assert.strictEqual(a.pickup_at, '2026-10-06');
      assert.strictEqual(a.equipment, 'reefer');
      assert.strictEqual(a.miles, 1065);
      assert.strictEqual(a.rate_cents, 290000);
      assert.ok(Math.abs(Date.parse(a.posted_at) - (Date.now() - 12 * 60e3)) < 5 * 60e3);
      assert.strictEqual(b.broker_name, 'North Star Logistics');
      assert.strictEqual(b.broker_mc, '555444');
      assert.strictEqual(b.weight_lbs, 12000);
      assert.strictEqual(b.rate_cents, null);
      const entry = state.log.find((x) => x.board === 'truckstop');
      assert.deepStrictEqual(entry, { board: 'truckstop', origin: 'Dallas, TX', radius: '150', equipment: 'Reefer', date: '10/06/2026' });
    });

    await check('123loadboard: seeded recipe → normalized row', async () => {
      const r = done.get('l123-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.data.count, 1);
      assert.deepStrictEqual(r.data.loads[0], {
        external_ref: '123-9001', broker_name: 'Volunteer Freight', broker_mc: '246810',
        origin: { city: 'Austin', state: 'TX', zip: null }, destination: { city: 'Nashville', state: 'TN', zip: null },
        pickup_at: '2026-10-06', equipment: 'flatbed', weight_lbs: 45000, miles: 880, rate_cents: 264000, rate_per_mile_cents: null,
        posted_at: r.data.loads[0].posted_at,
      });
      assert.strictEqual(state.log.find((x) => x.board === '123').equipment, 'Flatbed');
    });

    // Guards + limits.
    state.loggedIn.dat = false;
    state.captcha123 = true;
    pm._update(ts.id, { daily_counters: { date: localDateKey(), actions: 40, views: 0 } });
    runner.enqueue(job('dat-out', 'dat', basePayload));
    runner.enqueue(job('l123-captcha', '123loadboard', basePayload));
    runner.enqueue(job('ts-limit', 'truckstop', basePayload));
    await waitFor(['dat-out', 'l123-captcha', 'ts-limit']);
    runner.enqueue(job('dat-after', 'dat', basePayload));
    await waitFor(['dat-after']);

    await check('dat: login wall → blocked + logged_out, account_event, profile paused; next job skipped', async () => {
      const r = done.get('dat-out');
      assert.strictEqual(r.status, 'blocked', JSON.stringify(r));
      assert.ok(r.warnings.includes('logged_out'), JSON.stringify(r.warnings));
      assert.strictEqual(r.failed_step, 'check_logged_out');
      assert.ok(sent.some((m) => m.type === 'account_event' && m.payload.profile_id === dat.id && m.payload.event === 'logged_out' && m.payload.platform === 'dat'));
      assert.strictEqual(pm.get(dat.id).attention, 'logged_out');
      const n = done.get('dat-after');
      assert.strictEqual(n.status, 'skipped');
      assert.strictEqual(n.error, 'profile_needs_attention:logged_out');
      assert.deepStrictEqual(n.warnings, ['logged_out']);
      assert.strictEqual(pm.usage(pm.get(dat.id)).actions, 2, 'blocked search not counted as success');
    });

    await check('123loadboard: captcha → blocked + captcha_detected', async () => {
      const r = done.get('l123-captcha');
      assert.strictEqual(r.status, 'blocked', JSON.stringify(r));
      assert.ok(r.warnings.includes('captcha_detected'));
      assert.strictEqual(r.failed_step, 'check_captcha');
      assert.strictEqual(pm.get(l123.id).attention, 'captcha');
    });

    await check('truckstop: daily limit reached → skipped daily_limit_reached + rate_limited (browser never launched)', async () => {
      const r = done.get('ts-limit');
      assert.strictEqual(r.status, 'skipped');
      assert.strictEqual(r.error, 'daily_limit_reached');
      assert.deepStrictEqual(r.warnings, ['rate_limited']);
      assert.deepStrictEqual(r.data, { used: 40, limit: 40 });
      assert.ok(!sent.some((m) => m.type === 'job_progress' && m.payload.job_id === 'ts-limit'));
    });

    // Payload / platform validation.
    runner.enqueue(job('no-recipe', 'truckstop', basePayload, 'none/none'));
    runner.enqueue(job('bad-board', 'loadsmart', basePayload, 'dat/search_loads'));
    runner.enqueue({ job_id: 'no-origin', job_type: 'search_load_board', recipe: seeds['123loadboard/search_loads'], payload: { board: '123loadboard', equipment: 'van' } });
    await waitFor(['no-recipe', 'bad-board', 'no-origin']);
    await check('validation: daily limit hit before recipe check; unsupported board; missing origin', async () => {
      // truckstop is at its limit → skipped before the job even runs
      assert.strictEqual(done.get('no-recipe').error, 'daily_limit_reached');
      assert.strictEqual(done.get('bad-board').status, 'failed');
      assert.strictEqual(done.get('bad-board').error, 'unsupported_board:loadsmart');
      // 123loadboard profile is paused after captcha → skipped with attention reason
      assert.strictEqual(done.get('no-origin').error, 'profile_needs_attention:captcha');
    });
    pm.clearAttention(l123.id);
    runner.enqueue({ job_id: 'no-origin-2', job_type: 'search_load_board', recipe: seeds['123loadboard/search_loads'], payload: { board: '123loadboard', equipment: 'van' } });
    runner.enqueue({ job_id: 'no-recipe-2', job_type: 'search_load_board', payload: { ...basePayload, board: '123loadboard' } });
    await waitFor(['no-origin-2', 'no-recipe-2']);
    await check('validation: missing origin → failed; no recipe → recipe_required', async () => {
      assert.strictEqual(done.get('no-origin-2').status, 'failed');
      assert.strictEqual(done.get('no-origin-2').error, 'missing_payload_fields:origin');
      assert.strictEqual(done.get('no-recipe-2').error, 'recipe_required');
    });

    await check('board rows are never written to the launcher store', async () => {
      const raw = fs.readFileSync(store.file, 'utf8');
      for (const needle of ['DAT-1001', 'Acme Logistics', 'TS-77', '123-9001', '245000']) assert.ok(!raw.includes(needle), needle);
    });
  } finally {
    await runner.shutdown().catch(() => {});
    srv.close();
    fs.rmSync(process.env.KONEQTI_DATA_DIR, { recursive: true, force: true });
  }
  if (failures) {
    console.log(`\n${failures} load-board check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nsmoke-load-board: all checks passed');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
