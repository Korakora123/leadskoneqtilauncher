'use strict';
/**
 * Smoke test (headless): `scrape_directory` job (V2_API_INTEGRATIONS_CONTRACTS.md §8).
 *
 * Runs the SEEDED directory recipes (Leadskoneqtiapp/supabase/seeds/directory_recipes.sql) through the
 * REAL JobRunner → jobs/scrape-directory.js → recipe executor, in headless Chromium, against fixture
 * pages (test/fixtures/directory/*.html) served by a local HTTP server. Only the recipe's config URL
 * templates + hosts are rewritten to the local server; every list / detail step runs unchanged.
 *
 * Asserts: contract item shape + normalization (domain, redirect unwrapping, LinkedIn URLs, extra counts),
 * pager-link pagination (g2), page-param pagination + fallback selectors (clutch), detail visits for
 * items without a website (g2, crunchbase), limit_reached / no_more_pages / captcha (first page →
 * blocked, later page → partial success) / daily_limit (linkedin_search counts each page against the
 * LinkedIn daily limit), recipe guards, pacing, nothing written to the launcher store.
 *
 *   node test/smoke-directory.js       (SEEDS_SQL=… to override the seed file path)
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
process.env.KONEQTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-directory-'));

const SEEDS = process.env.SEEDS_SQL || path.join(__dirname, '..', '..', 'Leadskoneqtiapp', 'supabase', 'seeds', 'directory_recipes.sql');
const FIX = path.join(__dirname, 'fixtures', 'directory');

const { JsonStore } = require('../store');
const { ProfileManager, localDateKey } = require('../profile-manager');
const { JobRunner } = require('../playwright-runner');
const dirJob = require('../jobs/scrape-directory');

function loadSeeds() {
  const sql = fs.readFileSync(SEEDS, 'utf8');
  const out = {};
  const re = /VALUES \('directory:([\w]+)', '(scrape_directory)', (\d+), \$r\$([\s\S]*?)\$r\$::jsonb, '(\w+)'\)\s*ON CONFLICT \(platform, action, version\) DO NOTHING;/g;
  let m;
  while ((m = re.exec(sql))) {
    out[m[1]] = { id: `directory:${m[1]}`, version: Number(m[3]), steps: JSON.parse(m[4]), status: m[5] };
  }
  return out;
}

// ---------------- fixture server ----------------
const state = { log: [], captcha: new Set() };

function fixture(name, vars = {}) {
  let html = fs.readFileSync(path.join(FIX, name), 'utf8');
  for (const [k, v] of Object.entries(vars)) html = html.split(`{{${k}}}`).join(v);
  return html;
}

const titleCase = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      state.log.push(`${u.pathname}${u.search}`);
      const html = (status, body) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
      const site = u.pathname.split('/')[1];
      if (state.captcha.has(`${u.pathname}${u.search}`) || state.captcha.has(site)) return html(200, fixture('captcha.html'));
      let m;
      if (u.pathname === '/g2/search') {
        const q = u.searchParams.get('query') || '';
        const vars = { query: q, query_enc: encodeURIComponent(q) };
        const page = Number(u.searchParams.get('page') || 1);
        if (page === 1) return html(200, fixture('g2-search-1.html', vars));
        if (page === 2) return html(200, fixture('g2-search-2.html', vars));
        return html(200, '<html><body><h1>No results</h1></body></html>');
      }
      if ((m = /^\/g2\/products\/([\w-]+)\/reviews$/.exec(u.pathname))) {
        return html(200, fixture('g2-product.html', { slug: m[1], name: titleCase(m[1]) }));
      }
      if (u.pathname === '/clutch/agencies/seo') {
        const page = Number(u.searchParams.get('page') || 0);
        if (page === 0) return html(200, fixture('clutch-list-0.html'));
        if (page === 1) return html(200, fixture('clutch-list-1.html'));
        return html(200, fixture('clutch-list-empty.html'));
      }
      if (u.pathname === '/crunchbase/hub/fintech-companies') return html(200, fixture('crunchbase-hub.html'));
      if ((m = /^\/crunchbase\/organization\/([\w-]+)$/.exec(u.pathname))) {
        return html(200, fixture('crunchbase-org.html', { slug: m[1], name: titleCase(m[1]) }));
      }
      if (u.pathname.startsWith('/linkedin/search/results/')) return html(200, fixture('linkedin-search.html'));
      return html(404, '<html><body><h1>Not found</h1></body></html>');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const ORIGINS = {
  crunchbase: 'https://www.crunchbase.com',
  g2: 'https://www.g2.com',
  capterra: 'https://www.capterra.com',
  saashub: 'https://www.saashub.com',
  clutch: 'https://clutch.co',
  shopify_dirs: 'https://shop.app',
  linkedin_search: 'https://www.linkedin.com',
};

/** Point the config URL templates + hosts at the local server; list / detail steps stay unchanged. */
function rewrite(dir, recipe, base) {
  const prefix = `${base}/${dir === 'linkedin_search' ? 'linkedin' : dir}`;
  const steps = recipe.steps.map((s) => {
    if (s.action !== 'config') return s;
    const out = { ...s, hosts: ['127.0.0.1'] };
    for (const k of ['search_url', 'category_url']) if (out[k]) out[k] = out[k].replace(ORIGINS[dir], prefix);
    return out;
  });
  return { ...recipe, steps };
}

// ---------------- unit checks ----------------
function unitChecks() {
  assert.strictEqual(dirJob.normalizeDomain('HTTPS://WWW.Acme.IO/pricing?x=1'), 'acme.io');
  assert.strictEqual(dirJob.normalizeDomain('acme.co.uk'), 'acme.co.uk');
  assert.strictEqual(dirJob.normalizeDomain('not a domain'), null);
  assert.strictEqual(dirJob.normalizeDomain('http://127.0.0.1:8080'), null);
  assert.strictEqual(dirJob.normalizeWebsite('https://r.clutch.co/redirect?pid=1&u=https%3A%2F%2Fwww.Acme.io%2F%3Futm_source%3Dclutch', { hosts: ['clutch.co'] }), 'https://www.acme.io');
  assert.strictEqual(dirJob.normalizeWebsite('/products/x/redirect?url=https%3A%2F%2Facme.io%2Fen%2F', { base: 'https://www.g2.com/search', hosts: ['g2.com'] }), 'https://acme.io/en');
  assert.strictEqual(dirJob.normalizeWebsite('https://www.g2.com/products/x/reviews', { hosts: ['g2.com'] }), null, 'directory link is not a website');
  assert.strictEqual(dirJob.normalizeWebsite('https://twitter.com/acme'), null, 'social link is not a website');
  assert.strictEqual(dirJob.normalizeWebsite('acme.io'), 'https://acme.io');
  assert.strictEqual(dirJob.normalizeLinkedin('https://linkedin.com/company/acme-inc/about/?trk=x'), 'https://www.linkedin.com/company/acme-inc');
  assert.strictEqual(dirJob.normalizeLinkedin('https://www.linkedin.com/feed/'), null);
  const v = dirJob.templateVars('g2', { keywords: 'Email Marketing', category: null, location: 'Austin, TX' }, 10);
  assert.strictEqual(v.keywords_encoded, 'Email%20Marketing');
  assert.strictEqual(v.keywords_slug, 'email-marketing');
  assert.strictEqual(v.category_slug, 'email-marketing', 'category slug falls back to keywords');
  assert.strictEqual(v.keywords_location_encoded, 'Email%20Marketing%20Austin%2C%20TX');
  assert.strictEqual(v.search_type, 'companies');
  const it = dirJob.normalizeItem({ name: ' Acme ', website: 'https://www.acme.io/', rating: '4.5 out of 5', reviews_count: '(1,204)', tags: ['a', ''] },
    { base: 'https://www.g2.com/search', hosts: ['g2.com'], sourceUrl: 'https://www.g2.com/search' });
  assert.deepStrictEqual(it, {
    name: 'Acme', website: 'https://www.acme.io', domain: 'acme.io', description: null, category: null, location: null,
    linkedin_url: null, source_url: 'https://www.g2.com/search', extra: { rating: 4.5, reviews_count: 1204, tags: ['a'] },
  });
  console.log('ok   normalizers: domain, website (redirect unwrap, directory/social links dropped), linkedin, vars, item');
}

(async () => {
  unitChecks();
  const seeds = loadSeeds();
  assert.deepStrictEqual(Object.keys(seeds).sort(), [...dirJob.DIRECTORIES].sort(), 'one seed row per directory');
  for (const [dir, r] of Object.entries(seeds)) {
    assert.strictEqual(r.version, 1);
    assert.strictEqual(r.status, 'testing');
    const cfg = r.steps.find((s) => s.action === 'config');
    assert.ok(cfg && cfg.search_url && Array.isArray(cfg.hosts) && cfg.hosts.length, `${dir} config`);
    const ex = r.steps.find((s) => s.id === 'extract_items');
    assert.ok(ex && ex.phase === 'list' && ex.save_as === 'items' && ex.list_selectors.length >= 2, `${dir} list extract with fallbacks`);
    assert.ok(ex.fields.name && ex.fields.name.selectors.length >= 1, `${dir} name field`);
    assert.ok(r.steps.some((s) => s.id === 'list_check_captcha' && s.on_match === 'abort_blocked' && s.warning === 'captcha_detected'), `${dir} captcha guard`);
    assert.strictEqual(r.steps.find((s) => s.action === 'goto' && s.phase === 'list').url, '{{page_url}}');
    if (dir === 'linkedin_search') {
      assert.strictEqual(cfg.detail, 'never');
      assert.ok(r.steps.some((s) => s.warning === 'logged_out'), 'linkedin login guard');
    } else {
      assert.ok(r.steps.some((s) => s.phase === 'detail' && s.save_as === 'detail'), `${dir} detail extract`);
    }
  }
  console.log('ok   seeds: 7 directory:<name>/scrape_directory v1 testing rows, config + guards + list/detail phases');

  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const store = new JsonStore({ dir: process.env.KONEQTI_DATA_DIR, name: 's', defaults: { profiles: [] } });
  const pm = new ProfileManager({ store });
  const allHours = { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] };
  const li = pm.add({ platform: 'linkedin', handle: 'me@example.com', working_hours: allHours });

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
  const job = (id, directory, payload, { recipe = true } = {}) => ({
    job_id: id,
    job_type: 'scrape_directory',
    platform: `directory:${directory}`,
    recipe: recipe && seeds[directory] ? rewrite(directory, seeds[directory], base) : undefined,
    payload: { directory, ...payload },
  });

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log('ok  ', name); } catch (e) { failures += 1; console.log('FAIL', name, '\n', (e && e.stack) || e); }
  };
  const t0 = Date.now();

  try {
    runner.enqueue(job('g2-1', 'g2', { query: { keywords: 'crm' }, limit: 5 }));
    runner.enqueue(job('clutch-1', 'clutch', { query: { category: 'SEO' }, limit: 25 }));
    runner.enqueue(job('cb-1', 'crunchbase', { query: { category: 'Fintech' }, limit: 2 }));
    runner.enqueue(job('nore', 'g2', { query: { keywords: 'crm' } }, { recipe: false }));
    runner.enqueue(job('bad', 'yelp', { query: { keywords: 'crm' } }));
    await waitFor(['g2-1', 'clutch-1', 'cb-1', 'nore', 'bad']);

    await check('g2: pager link pagination, dedupe, limit_reached, detail visits fill website/linkedin/location', async () => {
      const r = done.get('g2-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.recipe_version, 1);
      const d = r.data;
      assert.strictEqual(d.directory, 'g2');
      assert.strictEqual(d.stopped_reason, 'limit_reached');
      assert.strictEqual(d.pages, 2);
      assert.deepStrictEqual(d.items.map((i) => i.name), ['Acme CRM', 'Pipely', 'DealDesk', 'LeadLoop', 'CloseIt']);
      const [acme, pipely, , leadloop, closeit] = d.items;
      assert.deepStrictEqual(Object.keys(acme), ['name', 'website', 'domain', 'description', 'category', 'location', 'linkedin_url', 'source_url', 'extra']);
      assert.strictEqual(acme.website, 'https://www.acmecrm.io', 'g2 redirect unwrapped, utm dropped');
      assert.strictEqual(acme.domain, 'acmecrm.io');
      assert.strictEqual(acme.category, 'CRM Software');
      assert.deepStrictEqual(acme.extra, { rating: 4.6, reviews_count: 1204 });
      assert.strictEqual(acme.source_url, `${base}/g2/products/acme-crm/reviews`);
      assert.strictEqual(acme.linkedin_url, null, 'acme had a website → no detail visit');
      assert.strictEqual(pipely.website, 'https://www.pipely.com');
      assert.strictEqual(pipely.domain, 'pipely.com');
      assert.strictEqual(pipely.linkedin_url, 'https://www.linkedin.com/company/pipely');
      assert.strictEqual(pipely.location, 'Austin, Texas');
      assert.strictEqual(pipely.description, 'Pipeline management for agencies.', 'list description kept');
      assert.strictEqual(pipely.extra.company, 'Pipely Inc.');
      assert.strictEqual(pipely.extra.founded, '2019');
      assert.strictEqual(pipely.extra.reviews_count, 88);
      assert.strictEqual(leadloop.domain, 'leadloop.com');
      assert.strictEqual(closeit.description, 'Closeit product overview.', 'detail fills an empty description');
      assert.strictEqual(d._meta.details_visited, 4);
      assert.strictEqual(d._meta.actions_used, 0);
      assert.ok(!state.log.includes('/g2/products/never-reached/reviews') && !state.log.includes('/g2/products/acme-crm/reviews'));
      assert.ok(state.log.includes('/g2/search?query=crm'), 'search_url template rendered');
      assert.ok(state.log.includes('/g2/search?query=crm&page=2'), 'pager next link followed');
      assert.ok(!state.log.includes('/g2/search?query=crm&page=3'), 'stopped at limit');
    });

    await check('clutch: category_url, fallback selectors, page_param pagination (page_start 0), redirect websites, no_more_pages', async () => {
      const r = done.get('clutch-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      const d = r.data;
      assert.strictEqual(d.stopped_reason, 'no_more_pages');
      assert.strictEqual(d.pages, 3);
      assert.deepStrictEqual(d.items.map((i) => [i.name, i.website, i.domain, i.location]), [
        ['Rankwise Digital', 'https://www.rankwise.co.uk', 'rankwise.co.uk', 'London, United Kingdom'],
        ['GrowthBay', 'https://growthbay.com', 'growthbay.com', 'Austin, TX'],
        ['SERPcraft', 'https://serpcraft.ca', 'serpcraft.ca', 'Toronto, Canada'],
      ]);
      assert.strictEqual(d.items[0].description, 'Data-driven SEO for SaaS');
      assert.deepStrictEqual(d.items[0].extra, { rating: 4.9, reviews_count: 32, min_project_size: '$5,000+', hourly_rate: '$50 - $99 / hr', employees: 10 });
      assert.strictEqual(d._meta.details_visited, 0, 'all items had websites');
      assert.ok(state.log.includes('/clutch/agencies/seo') && state.log.includes('/clutch/agencies/seo?page=1') && state.log.includes('/clutch/agencies/seo?page=2'));
      assert.ok(!(r.warnings || []).includes('captcha_detected'), 'reCAPTCHA footer text is not a challenge');
    });

    await check('crunchbase: hub category page, custom element rows, limit 2, org detail page → website + linkedin', async () => {
      const r = done.get('cb-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      const d = r.data;
      assert.strictEqual(d.stopped_reason, 'limit_reached');
      assert.strictEqual(d.pages, 1);
      assert.strictEqual(d.items.length, 2);
      const [payfox, ledgerly] = d.items;
      assert.deepStrictEqual(payfox, {
        name: 'Payfox', website: 'https://payfox.io', domain: 'payfox.io', description: 'Payments API for marketplaces',
        category: 'Fintech, Payments', location: 'Berlin, Germany', linkedin_url: 'https://www.linkedin.com/company/payfox-hq',
        source_url: `${base}/crunchbase/organization/payfox`,
        extra: { last_funding_type: 'Seed', last_funding_at: 'Sep 12, 2026', funding_total: '$2.5M', employees: 11 },
      });
      assert.strictEqual(ledgerly.domain, 'ledgerly.io');
      assert.strictEqual(ledgerly.location, 'Austin, Texas, United States', 'list location kept over detail');
      assert.strictEqual(d._meta.details_visited, 2);
      assert.ok(state.log.includes('/crunchbase/hub/fintech-companies'));
      assert.ok(!state.log.includes('/crunchbase/organization/third-co'));
    });

    await check('guards: no recipe → failed recipe_required; unknown directory → failed', async () => {
      assert.strictEqual(done.get('nore').status, 'failed');
      assert.strictEqual(done.get('nore').error, 'recipe_required');
      assert.strictEqual(done.get('bad').status, 'failed');
      assert.strictEqual(done.get('bad').error, 'unsupported_directory:yelp');
    });

    // Captcha on the first page (blocked) and on a later page (partial success).
    state.captcha.add('/g2/search?query=crm');
    state.captcha.add('/clutch/agencies/seo?page=1');
    runner.enqueue(job('g2-captcha', 'g2', { query: { keywords: 'crm' }, limit: 5 }));
    runner.enqueue(job('clutch-captcha', 'clutch', { query: { category: 'seo' } }));
    await waitFor(['g2-captcha', 'clutch-captcha']);

    await check('captcha on first page → blocked, captcha_detected, stopped_reason captcha, no items', async () => {
      const r = done.get('g2-captcha');
      assert.strictEqual(r.status, 'blocked', JSON.stringify(r));
      assert.ok(r.warnings.includes('captcha_detected'), JSON.stringify(r.warnings));
      assert.strictEqual(r.failed_step, 'list_check_captcha');
      assert.strictEqual(r.data.stopped_reason, 'captcha');
      assert.deepStrictEqual(r.data.items, []);
      assert.strictEqual(r.data.pages, 0);
    });

    await check('captcha on a later page → success with page-1 items, stopped_reason captcha, no detail visits', async () => {
      const r = done.get('clutch-captcha');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      assert.strictEqual(r.data.stopped_reason, 'captcha');
      assert.deepStrictEqual(r.data.items.map((i) => i.name), ['Rankwise Digital', 'GrowthBay']);
      assert.strictEqual(r.data.pages, 1);
      assert.ok(r.warnings.includes('captcha_detected'));
    });
    state.captcha.clear();

    // LinkedIn: week-1 warmup → 25% of 20 = 5 actions/day; 4 used → budget 1 page.
    assert.strictEqual(pm.dailyLimit(pm.get(li.id), 'actions'), 5);
    pm._update(li.id, { daily_counters: { date: localDateKey(), actions: 4, views: 0 } });
    runner.enqueue(job('li-1', 'linkedin_search', { query: { keywords: 'saas', location: 'Austin' }, limit: 10 }));
    await waitFor(['li-1']);
    runner.enqueue(job('li-2', 'linkedin_search', { query: { keywords: 'saas' } }));
    await waitFor(['li-2']);

    await check('linkedin_search: own LinkedIn profile, each page = 1 action, budget exhausted → daily_limit; next job skipped', async () => {
      const r = done.get('li-1');
      assert.strictEqual(r.status, 'success', JSON.stringify(r));
      const d = r.data;
      assert.strictEqual(d.stopped_reason, 'daily_limit');
      assert.strictEqual(d.pages, 1);
      assert.deepStrictEqual(d.items.map((i) => [i.name, i.linkedin_url, i.description, i.location]), [
        ['BrightDesk', 'https://www.linkedin.com/company/brightdesk', 'Software Development', 'San Francisco, CA'],
        ['Shipfast', 'https://www.linkedin.com/company/shipfast-io', 'E-commerce', 'Remote'],
      ]);
      assert.strictEqual(d.items[0].website, null);
      assert.strictEqual(d.items[0].extra.insight, '2K followers');
      assert.strictEqual(d._meta.actions_used, 1);
      assert.strictEqual(d._meta.profile_id, li.id);
      assert.ok(state.log.includes('/linkedin/search/results/companies/?keywords=saas%20Austin'), JSON.stringify(state.log.filter((x) => x.startsWith('/linkedin'))));
      assert.strictEqual(pm.usage(pm.get(li.id)).actions, 5, 'page loads counted toward the LinkedIn daily limit');
      const n = done.get('li-2');
      assert.strictEqual(n.status, 'skipped');
      assert.strictEqual(n.error, 'daily_limit_reached');
    });

    // Pacing: slow job gap (300-400 s × 0.01 scale = 3-4 s) between consecutive crunchbase jobs.
    const slow = (id) => {
      const j = job(id, 'crunchbase', { query: { category: 'fintech' }, limit: 1 });
      j.recipe.steps = j.recipe.steps.map((s) => (s.action === 'config' ? { ...s, job_gap_ms: [300000, 400000], detail: 'never' } : s));
      return j;
    };
    runner.enqueue(slow('cb-2'));
    runner.enqueue(slow('cb-3'));
    await waitFor(['cb-2', 'cb-3']);

    await check('pacing: randomized gap between jobs on the same directory + profile; nothing persisted', async () => {
      const a = done.get('cb-2');
      const b = done.get('cb-3');
      assert.strictEqual(a.status, 'success', JSON.stringify(a));
      assert.strictEqual(b.status, 'success', JSON.stringify(b));
      assert.ok(b.data._meta.paced_ms >= 2000 && b.data._meta.paced_ms <= 4000, `paced_ms=${b.data._meta.paced_ms}`);
      assert.ok(sent.some((m) => m.type === 'job_progress' && m.payload.job_id === 'cb-3' && m.payload.step === 'pacing'));
      assert.strictEqual(b.data.items.length, 1);
      assert.strictEqual(b.data._meta.details_visited, 0, "detail: 'never'");
      const storeText = fs.readdirSync(process.env.KONEQTI_DATA_DIR)
        .map((f) => { try { return fs.readFileSync(path.join(process.env.KONEQTI_DATA_DIR, f), 'utf8'); } catch (_) { return ''; } }).join('\n');
      for (const needle of ['Acme CRM', 'Rankwise', 'Payfox', 'BrightDesk', 'list_selectors']) {
        assert.ok(!storeText.includes(needle), `store must not contain ${needle}`);
      }
      assert.ok(sent.some((m) => m.type === 'job_progress' && m.payload.step === 'page'), 'page progress sent');
    });
  } finally {
    await runner.shutdown();
    srv.close();
  }
  console.log(`\n${failures ? `${failures} FAILED` : 'all directory smoke checks passed'} (${Math.round((Date.now() - t0) / 1000)}s)`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
