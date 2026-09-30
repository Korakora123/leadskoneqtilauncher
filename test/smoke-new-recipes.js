'use strict';
/**
 * Runs the NEW seeded recipes (parsed from supabase/seeds/automation_recipes.sql) through the
 * REAL launcher job modules + recipe executor, against mock pages that are served for the real
 * platform URLs via page.route (no network). Headless Chromium from /opt/pw-browsers.
 *   node /tmp/claude-0/e2e/recipes-test/smoke-new-recipes.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const L = path.join(__dirname, '..');
// Seed file lives in the dashboard repo (Leadskoneqtiapp); override with SEEDS_SQL.
const SEEDS = process.env.SEEDS_SQL || path.join(__dirname, '..', '..', 'Leadskoneqtiapp', 'supabase', 'seeds', 'automation_recipes.sql');
const pwRoot = '/opt/pw-browsers';
const dir = fs.readdirSync(pwRoot).find((d) => /^chromium-\d+$/.test(d));
process.env.CHROME_PATH = path.join(pwRoot, dir, 'chrome-linux', 'chrome');
process.env.KONEQTI_HEADLESS = '1';
process.env.KONEQTI_DELAY_SCALE = '0.01';
process.env.KONEQTI_QUIET = '1';
process.env.KONEQTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'koneqti-newrec-'));

const { JsonStore } = require(`${L}/store`);
const { ProfileManager } = require(`${L}/profile-manager`);
const { BrowserAdapter } = require(`${L}/browser/adapter`);
const { executeRecipe } = require(`${L}/recipe-executor`);
const { detectChallenges, BLOCKING_WARNINGS } = require(`${L}/detection`);
const behavior = require(`${L}/behavior`);
const job = (f) => require(`${L}/jobs/${f}`);

function loadSeeds() {
  const sql = fs.readFileSync(SEEDS, 'utf8');
  const out = {};
  const re = /VALUES \('([\w]+)', '([\w]+)', (\d+), \$r\$([\s\S]*?)\$r\$/g;
  let m;
  while ((m = re.exec(sql))) out[`${m[1]}/${m[2]}`] = { id: `${m[1]}/${m[2]}`, version: Number(m[3]), steps: JSON.parse(m[4]) };
  return out;
}

// ---------------- mock pages (keyed by URL without query) ----------------
const PAGES = {};
const FB_POST = (i, text) => `<div class="x1yztbdb"><div role="article" aria-labelledby="h${i}">
  <h3 id="h${i}"><span><strong><a role="link" href="https://www.facebook.com/groups/123/user/9${i}/">Owner ${i}</a></strong></span></h3>
  <span><a href="https://www.facebook.com/groups/123/posts/55${i}/"><span>${i} hours ago</span></a></span>
  <div data-ad-rendering-role="story_message"><div dir="auto" style="text-align:start">${text}</div></div>
  <div role="button" aria-label="Like">Like</div></div></div>`;
PAGES['https://www.facebook.com/groups/dispatchers'] = `<!doctype html><html><body><div role="main"><div role="feed">
  ${FB_POST(1, 'Anyone know a good truck dispatcher? Need dispatcher for my 2 box trucks')}
  ${FB_POST(2, 'Selling a used trailer, DM me')}
  ${FB_POST(3, 'Looking for dispatcher, new MC authority, lanes TX to GA')}
  <div class="x1yztbdb"><div role="article">sponsored card without message</div></div>
  <div style="height:1500px"></div></div></div></body></html>`;
PAGES['https://www.facebook.com/groups/blockedgroup'] = `<!doctype html><html><body><h2>You're Temporarily Blocked</h2><p>It looks like you were misusing this feature.</p></body></html>`;

const TT_ITEM = (i, extra = '') => `<div data-e2e="user-post-item"><a href="https://www.tiktok.com/@bakery/video/70${i}">
  <img alt="cake video ${i}"><strong data-e2e="video-views">${i}.${i}K</strong></a>${extra}</div>`;
const TT_PROFILE = `<!doctype html><html><head><meta name="description" content="Sweet Bakery (@bakery) on TikTok | 120.5K Likes. 12.3K Followers. Cakes DM to order"></head><body>
  <h1 data-e2e="user-title">bakery</h1><h2 data-e2e="user-subtitle">Sweet Bakery</h2>
  <h2 data-e2e="user-bio">Custom cakes 🎂 DM to order · wa.me/971501234567</h2>
  <a data-e2e="user-link" href="https://sweetbakery.example">sweetbakery.example</a>
  <strong data-e2e="following-count">210</strong><strong data-e2e="followers-count">12.3K</strong><strong data-e2e="likes-count">120.5K</strong>
  <div data-e2e="user-post-item-list">${[1, 2, 3].map((i) => TT_ITEM(i)).join('')}</div></body></html>`;
PAGES['https://www.tiktok.com/@bakery'] = TT_PROFILE;
PAGES['https://www.tiktok.com/tag/dubaicakes'] = `<!doctype html><html><body><div data-e2e="challenge-item-list">
  ${[1, 2].map((i) => `<div data-e2e="challenge-item"><a href="https://www.tiktok.com/@shop${i}/video/80${i}"><strong data-e2e="video-views">${i}M</strong></a>
  <a href="/@shop${i}"><p data-e2e="challenge-item-username">shop${i}</p></a><div data-e2e="challenge-item-desc">Order cake #dubaicakes ${i}</div></div>`).join('')}
  </div></body></html>`;
PAGES['https://www.tiktok.com/search'] = `<!doctype html><html><body>
  <div data-e2e="search-user-container"><p data-e2e="search-user-unique-id">cakeshop_dxb</p><p data-e2e="search-user-nickname">Cake Shop DXB</p>
    <span data-e2e="search-follow-count">45.1K Followers</span><p data-e2e="search-user-desc">DM to order</p></div>
  <div data-e2e="search_top-item"><a href="https://www.tiktok.com/@cakeshop_dxb/video/901"><strong data-e2e="video-views">300K</strong></a>
    <div data-e2e="search-card-desc">Best cake in Dubai</div><p data-e2e="search-card-user-unique-id">cakeshop_dxb</p></div>
  </body></html>`;
PAGES['https://www.tiktok.com/@captcha'] = `<!doctype html><html><body><div>Drag the slider to fit the puzzle</div></body></html>`;

// Instagram profile with grid; clicking a post opens a dialog with <time>.
PAGES['https://www.instagram.com/mikesplumbing/'] = `<!doctype html><html><head>
  <meta name="description" content="2,345 Followers, 180 Following, 97 Posts - See Instagram photos and videos from Mike's Plumbing (@mikesplumbing)"></head><body>
  <main><header><section><ul><li><span><span>97</span> posts</span></li>
    <li><a href="/mikesplumbing/followers/"><span title="2,345"><span>2,345</span></span> followers</a></li>
    <li><a href="/mikesplumbing/following/"><span><span>180</span></span> following</a></li></ul></section></header>
  <div>${[1, 2, 3].map((i) => `<a href="/p/ABC${i}/" onclick="event.preventDefault();document.getElementById('dlg').hidden=false">${i === 1 ? '<svg aria-label="Pinned post icon"></svg>' : ''}<img alt="post ${i}">
     <ul><li><span><span>${i * 10}</span></span></li><li><span><span>${i}</span></span></li></ul></a>`).join('')}</div></main>
  <div id="dlg" role="dialog" hidden><article><time datetime="2026-09-20T10:00:00.000Z">Sep 20</time></article></div></body></html>`;

// LinkedIn profile → activity
PAGES['https://www.linkedin.com/in/mikesmith/'] = `<!doctype html><html><body><main>
  <h1 class="text-heading-xlarge">Mike Smith</h1>
  <ul class="pv-top-card--list"><li class="text-body-small"><span>500+ connections</span></li></ul>
  <section><div id="content_collections"></div><h2>Activity</h2><p class="pvs-header__optional-link"><span>3,456 followers</span></p>
  <a href="/in/mikesmith/recent-activity/all/">Show all posts</a></section></main></body></html>`;
PAGES['https://www.linkedin.com/in/mikesmith/recent-activity/all/'] = `<!doctype html><html><body><main>
  ${[1, 2].map((i) => `<div class="feed-shared-update-v2" data-urn="urn:li:activity:7000${i}">
     <div class="update-components-actor__sub-description"><span aria-hidden="true">${i}d •</span><span class="visually-hidden">${i} days ago • Visible to anyone</span></div>
     <a href="https://www.linkedin.com/feed/update/urn:li:activity:7000${i}/">post</a>
     <ul><li class="social-details-social-counts__reactions"><span class="social-details-social-counts__reactions-count">${i * 40}</span></li>
     <li class="social-details-social-counts__comments"><button><span>${i * 4} comments</span></button></li></ul></div>`).join('')}
  </main></body></html>`;

// Like pages (not liked / already liked)
const IG_POST = (liked) => `<!doctype html><html><body><article><section>
  <div role="button" onclick="var s=this.querySelector('svg');s.setAttribute('aria-label',s.getAttribute('aria-label')==='Like'?'Unlike':'Like')"><div><span><svg aria-label="${liked ? 'Unlike' : 'Like'}" height="24" width="24"><rect width="24" height="24"/></svg></span></div></div>
  <div role="button"><svg aria-label="Comment" height="24" width="24"><rect width="24" height="24"/></svg></div></section>
  <ul><li>great! <svg aria-label="Like" height="12" width="12"><rect width="12" height="12"/></svg></li></ul>
  <section><form onsubmit="return false"><textarea aria-label="Add a comment…" placeholder="Add a comment…"></textarea>
   <div role="button" onclick="var t=this.closest('form').querySelector('textarea');var li=document.createElement('li');li.textContent=t.value;document.querySelector('ul').appendChild(li);window.__comment=t.value;t.value=''">Post</div></form></section>
  </article></body></html>`;
PAGES['https://www.instagram.com/p/LIKE1/'] = IG_POST(false);
PAGES['https://www.instagram.com/p/LIKED/'] = IG_POST(true);
PAGES['https://www.instagram.com/p/NOCOMMENT/'] = `<!doctype html><html><body><article><section><svg aria-label="Like" height="24"></svg><svg aria-label="Comment" height="24"></svg></section>
  <div>Commenting has been turned off.</div></article></body></html>`;
PAGES['https://www.instagram.com/p/BLOCKED/'] = `<!doctype html><html><body><h2>Try Again Later</h2><p>We restrict certain activity to protect our community.</p></body></html>`;

const FB_PERMA = (liked) => `<!doctype html><html><body><div role="main"><div role="article">
  <div data-ad-rendering-role="story_message">Need help with reviews</div>
  <div role="button" aria-label="${liked ? 'Remove Like' : 'Like'}" onclick="this.setAttribute('aria-label',this.getAttribute('aria-label')==='Like'?'Remove Like':'Like')"><span>Like</span></div>
  <div role="button" aria-label="Leave a comment" onclick="document.getElementById('box').focus()">Comment</div>
  <div id="comments"></div>
  <form onsubmit="return false"><div id="box" role="textbox" contenteditable="true" aria-label="Write a comment…"
    onkeydown="if(event.key==='Enter'&&!event.shiftKey){var d=document.createElement('div');d.textContent=this.innerText;document.getElementById('comments').appendChild(d);window.__comment=this.innerText;this.textContent='';event.preventDefault();}"></div></form>
  </div></div></body></html>`;
PAGES['https://www.facebook.com/groups/123/posts/551/'] = FB_PERMA(false);
PAGES['https://www.facebook.com/groups/123/posts/552/'] = FB_PERMA(true);

const LI_POST = (pressed) => `<!doctype html><html><body><main><article><div class="feed-shared-update-v2" data-urn="urn:li:activity:1">
  <p>We are hiring an office admin</p>
  <div class="feed-shared-social-action-bar">
   <button class="react-button__trigger" aria-label="React Like" aria-pressed="${pressed}" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed')==='true'?'false':'true')"><span>Like</span></button>
   <button aria-label="Comment" onclick="document.getElementById('cb').hidden=false"><span>Comment</span></button></div>
  <div id="cb" hidden><form class="comments-comment-box__form" onsubmit="return false">
   <div class="comments-comment-texteditor"><div class="ql-editor" contenteditable="true" role="textbox" data-placeholder="Add a comment…"></div></div>
   <button type="submit" class="comments-comment-box__submit-button--cr" onclick="var e=this.form.querySelector('.ql-editor');var p=document.createElement('p');p.textContent=e.innerText;document.getElementById('cl').appendChild(p);window.__comment=e.innerText;e.textContent=''"><span>Comment</span></button></form></div>
  <div id="cl"></div>
  <div class="comments-comment-item"><button class="react-button__trigger" aria-label="React Like to Jane's comment" aria-pressed="false"><span>Like</span></button></div>
  </div></article></main></body></html>`;
PAGES['https://www.linkedin.com/feed/update/urn:li:activity:1/'] = LI_POST(false);
PAGES['https://www.linkedin.com/feed/update/urn:li:activity:2/'] = LI_POST(true);

// ---------------- harness ----------------
function makeCtx(page, jobMsg, platform) {
  const meta = { skipped_steps: [], ai_selectors_used: [] };
  const payload = jobMsg.payload || {};
  return {
    meta,
    ctx: {
      job: jobMsg, payload, page, platform, signal: undefined, behavior,
      log: { info() {}, warn() {}, error() {} },
      progress() {},
      async runRecipe(vars = {}, recipe = jobMsg.recipe) {
        const res = await executeRecipe(page, recipe, { vars: { ...payload, ...vars }, requestSelector: async () => null });
        meta.skipped_steps.push(...res.skipped_steps);
        meta.ai_selectors_used.push(...res.ai_selectors_used);
        return res;
      },
      async detect() {
        const d = await detectChallenges(page, { platform });
        return { ...d, blocking: d.warnings.some((w) => BLOCKING_WARNINGS.includes(w)) };
      },
    },
  };
}

(async () => {
  const seeds = loadSeeds();
  const pm = new ProfileManager({ store: new JsonStore({ dir: process.env.KONEQTI_DATA_DIR, name: 's', defaults: { profiles: [] } }) });
  const adapter = new BrowserAdapter('chromium_patched', { profileManager: pm, headless: true });
  await adapter.launch(pm.ensureWebProfile('chromium_patched', 1));
  const page = await adapter.newPage();
  const served = [];
  await page.context().route('**/*', (route) => {
    const u = route.request().url().split('?')[0].split('#')[0];
    const body = PAGES[u];
    if (route.request().resourceType() === 'document') served.push(u);
    return route.fulfill({ status: body ? 200 : 404, contentType: 'text/html; charset=utf-8', body: body || '<html><body>not found</body></html>' });
  });

  const run = async (file, platform, action, payload, jobPlatform) => {
    const recipe = seeds[`${platform}/${action}`];
    assert.ok(recipe, `seed ${platform}/${action} missing`);
    const msg = { job_id: 'j', platform: jobPlatform, payload, recipe };
    const { ctx, meta } = makeCtx(page, msg, platform);
    try {
      const out = await job(file).run(ctx);
      return { ok: true, out, meta };
    } catch (err) {
      return { ok: false, err, meta };
    }
  };
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(['ok  ', name]); console.log('ok   ', name); } catch (e) { results.push(['FAIL', name]); console.log('FAIL ', name, '\n', e && e.stack || e); process.exitCode = 1; }
  };

  try {
    await check('facebook/scrape_groups via scrape-facebook-groups.js (keywords filter, blocked group reported)', async () => {
      const r = await run('scrape-facebook-groups', 'facebook', 'scrape_groups',
        { group_urls: ['https://www.facebook.com/groups/dispatchers', 'https://www.facebook.com/groups/blockedgroup'], keywords: ['dispatcher'], max_posts_per_group: 10 });
      // blocked group → the job re-throws (blocked) because err.blocked
      assert.ok(!r.ok && r.err.blocked === true, 'blocked group must stop job as blocked');
      const r2 = await run('scrape-facebook-groups', 'facebook', 'scrape_groups', { group_urls: ['https://www.facebook.com/groups/dispatchers'], keywords: ['dispatcher'], max_posts_per_group: 10 });
      assert.ok(r2.ok, r2.err && r2.err.message);
      const d = r2.out.data;
      assert.strictEqual(d.groups_checked, 1);
      assert.strictEqual(d.posts.length, 2, JSON.stringify(d.posts));
      const p = d.posts[0];
      assert.strictEqual(p.author, 'Owner 1');
      assert.strictEqual(p.author_url, 'https://www.facebook.com/groups/123/user/91/');
      assert.ok(p.text.includes('Need dispatcher'));
      assert.strictEqual(p.url, 'https://www.facebook.com/groups/123/posts/551/');
      assert.ok(p.posted_at, 'relative date parsed');
      assert.deepStrictEqual(p.matched_keywords, ['dispatcher']);
    });

    await check('tiktok/scrape_profile mode=profile', async () => {
      const r = await run('scrape-tiktok', 'tiktok', 'scrape_profile', { mode: 'profile', handle: 'bakery', max_results: 2 });
      assert.ok(r.ok, r.err && r.err.message);
      const { profiles, videos } = r.out.data;
      assert.strictEqual(profiles.length, 1);
      assert.strictEqual(profiles[0].handle, 'bakery');
      assert.strictEqual(profiles[0].followers, 12300);
      assert.strictEqual(profiles[0].likes, 120500);
      assert.strictEqual(profiles[0].following, 210);
      assert.strictEqual(profiles[0].dm_to_order, true);
      assert.deepStrictEqual(profiles[0].whatsapp_links, ['https://wa.me/971501234567']);
      assert.strictEqual(profiles[0].external_url, 'https://sweetbakery.example/');
      assert.strictEqual(videos.length, 2);
      assert.strictEqual(videos[0].views, 1100);
      assert.ok(videos[0].url.endsWith('/video/701'));
    });
    await check('tiktok/scrape_profile mode=hashtag (no bogus profile)', async () => {
      const r = await run('scrape-tiktok', 'tiktok', 'scrape_profile', { mode: 'hashtag', hashtag: '#dubaicakes' });
      assert.ok(r.ok, r.err && r.err.message);
      assert.strictEqual(r.out.data.profiles.length, 0);
      assert.strictEqual(r.out.data.videos.length, 2);
      assert.strictEqual(r.out.data.videos[1].author, 'shop2');
      assert.strictEqual(r.out.data.videos[1].views, 2000000);
      assert.ok(r.out.data.videos[1].caption.includes('#dubaicakes'));
    });
    await check('tiktok/scrape_profile mode=search (users + videos)', async () => {
      const r = await run('scrape-tiktok', 'tiktok', 'scrape_profile', { mode: 'search', query: 'cake dubai' });
      assert.ok(r.ok, r.err && r.err.message);
      assert.strictEqual(r.out.data.profiles.length, 1);
      assert.strictEqual(r.out.data.profiles[0].handle, 'cakeshop_dxb');
      assert.strictEqual(r.out.data.profiles[0].followers, 45100);
      assert.strictEqual(r.out.data.profiles[0].dm_to_order, true);
      assert.strictEqual(r.out.data.videos.length, 1);
      assert.strictEqual(r.out.data.videos[0].views, 300000);
      assert.strictEqual(r.out.data.videos[0].author, 'cakeshop_dxb');
    });
    await check('tiktok/scrape_profile captcha → blocked', async () => {
      const r = await run('scrape-tiktok', 'tiktok', 'scrape_profile', { mode: 'profile', handle: 'captcha' });
      assert.ok(!r.ok && r.err.blocked === true && r.err.failed_step === 'check_blocked');
    });

    await check('instagram/check_profile via check-social-profile.js', async () => {
      const r = await run('check-social-profile', 'instagram', 'check_profile', { handle: 'mikesplumbing' }, 'instagram');
      assert.ok(r.ok, r.err && r.err.message);
      const d = r.out.data;
      assert.strictEqual(d.followers, 2345);
      assert.strictEqual(d.following, 180);
      assert.strictEqual(d.posts_count, 97);
      assert.strictEqual(d.last_post_at, '2026-09-20T10:00:00.000Z');
      assert.strictEqual(d.recent_posts.length, 3);
      assert.strictEqual(d.recent_posts[1].likes, 20);
      assert.strictEqual(d.recent_posts[1].comments_count, 2);
      assert.ok(d.recent_posts[0].url.endsWith('/p/ABC1/'));
    });
    await check('tiktok/check_profile via check-social-profile.js', async () => {
      const r = await run('check-social-profile', 'tiktok', 'check_profile', { handle: 'bakery' }, 'tiktok');
      assert.ok(r.ok, r.err && r.err.message);
      const d = r.out.data;
      assert.strictEqual(d.followers, 12300);
      assert.strictEqual(d.following, 210);
      assert.strictEqual(d.recent_posts.length, 3);
      assert.strictEqual(d.recent_posts[2].views, 3300);
    });
    await check('linkedin/check_profile via check-social-profile.js (followers + activity posts)', async () => {
      const r = await run('check-social-profile', 'linkedin', 'check_profile', { handle: 'mikesmith' }, 'linkedin');
      assert.ok(r.ok, r.err && r.err.message);
      const d = r.out.data;
      assert.strictEqual(d.followers, 3456);
      assert.strictEqual(d.recent_posts.length, 2);
      assert.strictEqual(d.recent_posts[1].likes, 80);
      assert.strictEqual(d.recent_posts[1].comments_count, 8);
      assert.ok(d.recent_posts[0].posted_at, 'relative date parsed');
      assert.ok(d.last_post_at);
      assert.ok(d.recent_posts[0].url.includes('urn:li:activity:70001'));
    });

    for (const [platform, url, likedUrl, getLiked] of [
      ['instagram', 'https://www.instagram.com/p/LIKE1/', 'https://www.instagram.com/p/LIKED/', () => page.getAttribute('section svg[height="24"]', 'aria-label')],
      ['facebook', 'https://www.facebook.com/groups/123/posts/551/', 'https://www.facebook.com/groups/123/posts/552/', () => page.getAttribute('div[role="button"][aria-label$="Like"]', 'aria-label')],
      ['linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:1/', 'https://www.linkedin.com/feed/update/urn:li:activity:2/', () => page.getAttribute('.feed-shared-social-action-bar button.react-button__trigger', 'aria-pressed')],
    ]) {
      await check(`${platform}/like via content-like.js (like, then already-liked → skipped)`, async () => {
        const r = await run('content-like', platform, 'like', { platform, post_url: url, prospect_id: 'p1' }, platform);
        assert.ok(r.ok, r.err && `${r.err.message} @${r.err.failed_step}`);
        assert.strictEqual(r.out.data.liked, true);
        assert.strictEqual(r.out.countAction, true);
        assert.ok(['Unlike', 'Remove Like', 'true'].includes(await getLiked()), 'like toggled on');
        if (platform === 'linkedin') assert.strictEqual(await page.getAttribute('.comments-comment-item button', 'aria-pressed'), 'false', 'comment like untouched');
        const r2 = await run('content-like', platform, 'like', { platform, post_url: likedUrl }, platform);
        assert.ok(!r2.ok && r2.err.status === 'skipped', `expected skipped, got ${r2.ok ? 'ok' : r2.err.message}`);
        assert.ok(r2.err.data.state.already_liked);
        assert.ok(['Unlike', 'Remove Like', 'true'].includes(await getLiked()), 'already-liked NOT toggled off');
      });
    }
    for (const [platform, url] of [
      ['instagram', 'https://www.instagram.com/p/LIKE1/'],
      ['facebook', 'https://www.facebook.com/groups/123/posts/551/'],
      ['linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:1/'],
    ]) {
      await check(`${platform}/comment via community-engage.js`, async () => {
        const comment = 'Great point on response times, thanks for sharing.';
        const r = await run('community-engage', platform, 'comment', { platform, post_url: url, comment }, platform);
        assert.ok(r.ok, r.err && `${r.err.message} @${r.err.failed_step}`);
        assert.strictEqual(r.out.data.commented, true);
        assert.strictEqual(await page.evaluate(() => window.__comment), comment);
        assert.ok(!r.meta.skipped_steps.includes('verify'), 'comment verified on page');
      });
    }
    await check('instagram/comment on post with commenting off → skipped (cannot_message)', async () => {
      const r = await run('community-engage', 'instagram', 'comment', { platform: 'instagram', post_url: 'https://www.instagram.com/p/NOCOMMENT/', comment: 'hi' }, 'instagram');
      assert.ok(!r.ok && r.err.status === 'skipped', r.ok ? 'ran' : r.err.message);
      assert.ok(r.err.data.state.cannot_message);
    });
    await check('instagram/like blocked page → blocked', async () => {
      const r = await run('content-like', 'instagram', 'like', { platform: 'instagram', post_url: 'https://www.instagram.com/p/BLOCKED/' }, 'instagram');
      assert.ok(!r.ok && r.err.blocked === true);
    });
  } finally {
    await adapter.close();
    fs.rmSync(process.env.KONEQTI_DATA_DIR, { recursive: true, force: true });
    console.log(`\n${results.filter((x) => x[0] === 'ok  ').length}/${results.length} passed`);
  }
})();
