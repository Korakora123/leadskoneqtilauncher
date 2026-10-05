'use strict';
/**
 * scrape_directory — company directory list scrape (V2_API_INTEGRATIONS_CONTRACTS.md §8).
 * Electron FALLBACK only: the brain uses official APIs / feeds first (SEC EDGAR, ProductHunt,
 * KoneqtiSEO feed, Apollo / Hunter) and dispatches this job only for niches they miss.
 *
 * payload: { directory: crunchbase|g2|capterra|saashub|clutch|shopify_dirs|linkedin_search,
 *            query: { keywords?, category?, location?, url?, type?: 'companies'|'people' (linkedin) },
 *            limit?=25 (≤ 100; linkedin_search ≤ 50) }
 * job.recipe = automation_recipes.steps for platform 'directory:<directory>', action 'scrape_directory'
 * result data: { directory, items: [{ name, website, domain, description, category, location,
 *                linkedin_url, source_url, extra }], pages, stopped_reason, _meta }
 * stopped_reason: limit_reached | no_more_pages | captcha | blocked | daily_limit | error
 *
 * Recipe layout (steps array, brain-only, never stored here):
 *   { action: 'config', phase: 'config', search_url, category_url?, hosts[], page_param?, page_start?,
 *     max_pages?, detail?: 'missing_website'|'always'|'never', max_details?, page_delay_ms?: [min,max],
 *     job_gap_ms?: [min,max] }                       ← read by this module, never executed
 *   { phase: 'list', ... }   executed once per results page; goto "{{page_url}}", guards, extract
 *                            save_as 'items' (list) + optional save_as 'pager' { next_url }
 *   { phase: 'detail', ... } executed per item that needs it; goto "{{detail_url}}", extract save_as 'detail'
 *
 * Pacing: human delays inside the recipe executor, a randomized gap between result / detail pages,
 * and a randomized gap between consecutive jobs on the same directory + profile.
 * linkedin_search runs on the user's LinkedIn profile and every LinkedIn page load counts as one
 * action toward the LinkedIn daily limit (20, warmup applies) → stopped_reason 'daily_limit'.
 * Items go to the brain only — never written to disk or logged.
 */
const { JobError, requireRecipe, pickList, pickObj, clean, parseCount, parseRating } = require('./_helpers');

const DIRECTORIES = ['crunchbase', 'g2', 'capterra', 'saashub', 'clutch', 'shopify_dirs', 'linkedin_search'];
const DEFAULT_LIMIT = 25;
const LIMIT_CAP = 100;
const LINKEDIN_LIMIT_CAP = 50;
const MAX_PAGES_CAP = 10;
const LINKEDIN_MAX_PAGES_CAP = 5;
const MAX_DETAILS_CAP = 25;

const DEFAULTS = {
  page_delay_ms: [4000, 9000],
  detail_delay_ms: [3000, 7000],
  job_gap_ms: [20000, 45000],
};

/** `${profile_id}:${directory}` → epoch ms before which the next job must not start (memory only). */
const nextAllowedAt = new Map();

const ITEM_FIELDS = ['name', 'website', 'domain', 'description', 'category', 'location', 'linkedin_url', 'source_url'];
const INTERNAL_FIELDS = ['detail_url', 'url', 'link', 'next_url'];
const COUNT_EXTRA = ['reviews_count', 'review_count', 'reviews', 'employees', 'employee_count', 'followers', 'products_count'];
/** Never a company website (social profiles, link shorteners, app stores). */
const NON_WEBSITE_HOSTS = ['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'youtube.com',
  'tiktok.com', 'pinterest.com', 'github.com', 'crunchbase.com', 'g2.com', 'capterra.com', 'saashub.com', 'clutch.co',
  'bit.ly', 'apps.apple.com', 'play.google.com', 'shop.app'];
const REDIRECT_PARAMS = ['u', 'url', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'to', 'href', 'link'];

function delayScale() {
  const s = Number(process.env.KONEQTI_DELAY_SCALE || 1);
  return Number.isFinite(s) && s >= 0 ? s : 1;
}

function range(v, fallback) {
  if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x)))) {
    const a = Math.max(0, Number(v[0]));
    return [a, Math.max(a, Number(v[1]))];
  }
  return fallback;
}

function slugify(v) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------- URL / domain normalization ----------------

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; }
}

function bareHost(h) {
  return String(h || '').toLowerCase().replace(/^www\d?\./, '').replace(/\.$/, '');
}

function hostMatches(host, hosts) {
  const h = bareHost(host);
  return Boolean(h) && (hosts || []).some((x) => {
    const d = bareHost(x);
    return d && (h === d || h.endsWith(`.${d}`));
  });
}

/** Absolute http(s) URL or null. Resolves relative links against `base`. */
function absUrl(v, base) {
  const s = clean(v, 2000);
  if (!s || /^(javascript|mailto|tel|data):/i.test(s) || s === '#') return null;
  try {
    const u = new URL(s, base || undefined);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch (_) {
    return null;
  }
}

/** "https://WWW.Acme.io/path?x" → "acme.io"; "acme.io" → "acme.io"; garbage → null. */
function normalizeDomain(v) {
  let s = clean(v, 2000);
  if (!s) return null;
  s = s.toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s.replace(/^\/+/, '')}`;
  let host;
  try { host = new URL(s).hostname; } catch (_) { return null; }
  host = bareHost(host);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/**
 * Company website from a raw link/text. Unwraps directory redirect links
 * (r.clutch.co/redirect?u=…, capterra external_click?url=…) and drops links that stay on the directory.
 * Returns "https://acme.io" (or with path when meaningful), without query / hash.
 */
function normalizeWebsite(v, { base, hosts = [] } = {}) {
  const raw = clean(v, 2000);
  if (!raw) return null;
  let u = absUrl(raw, base);
  if (!u && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(raw)) u = absUrl(`https://${raw}`);
  if (!u) return null;
  for (let hop = 0; hop < 3 && u; hop += 1) {
    if (!hostMatches(u.hostname, hosts) && !/^r\./.test(u.hostname)) break;
    let next = null;
    for (const p of REDIRECT_PARAMS) {
      const val = u.searchParams.get(p);
      if (val && /^(https?:\/\/|www\.)/i.test(val)) { next = absUrl(/^www\./i.test(val) ? `https://${val}` : val); break; }
    }
    if (!next) return null; // a link that stays on the directory is not the company website
    u = next;
  }
  if (!u || hostMatches(u.hostname, hosts) || hostMatches(u.hostname, NON_WEBSITE_HOSTS)) return null;
  const domain = normalizeDomain(u.href);
  if (!domain) return null;
  const pathPart = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.hostname.toLowerCase()}${pathPart && pathPart !== '/' ? pathPart : ''}`;
}

/** LinkedIn company / school / profile URL → "https://www.linkedin.com/company/acme" (no query, no slash). */
function normalizeLinkedin(v, base) {
  const u = absUrl(v, base);
  if (!u || !/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const m = /^\/(company|in|school|showcase)\/([^/?#]+)/i.exec(u.pathname);
  if (!m) return null;
  return `https://www.linkedin.com/${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`;
}

// ---------------- payload → recipe vars ----------------

function parseConfig(steps) {
  const cfg = (steps || []).find((s) => s && (s.phase === 'config' || s.action === 'config')) || {};
  return cfg;
}

function phaseSteps(steps, phase) {
  return (steps || []).filter((s) => s && s.action !== 'config' && s.phase !== 'config' && (s.phase || 'list') === phase);
}

function normalizeQuery(q) {
  const src = typeof q === 'string' ? { keywords: q } : q && typeof q === 'object' ? q : {};
  return {
    keywords: clean(src.keywords, 200),
    category: clean(src.category, 200),
    location: clean(src.location, 200),
    url: clean(src.url, 2000),
    type: clean(src.type, 20),
  };
}

function templateVars(directory, query, limit) {
  const enc = (v) => encodeURIComponent(v || '');
  const searchText = [query.keywords, query.category, query.location].filter(Boolean).join(' ');
  const keywordsLocation = [query.keywords || query.category, query.location].filter(Boolean).join(' ');
  return {
    directory,
    keywords: query.keywords || '',
    keywords_encoded: enc(query.keywords || query.category),
    keywords_plus: (query.keywords || query.category || '').trim().split(/\s+/).map(enc).join('+'),
    keywords_slug: slugify(query.keywords || query.category),
    category: query.category || '',
    category_encoded: enc(query.category),
    category_slug: slugify(query.category || query.keywords),
    location: query.location || '',
    location_encoded: enc(query.location),
    location_slug: slugify(query.location),
    search_text: searchText,
    search_text_encoded: enc(searchText),
    keywords_location_encoded: enc(keywordsLocation),
    search_type: query.type === 'people' ? 'people' : 'companies',
    limit,
    max_results: limit,
  };
}

/** First results-page URL: explicit query.url (must stay on the directory) → category_url → search_url. */
function startUrl(cfg, query, vars, render) {
  const hosts = Array.isArray(cfg.hosts) ? cfg.hosts : [];
  if (query.url) {
    const u = absUrl(query.url);
    if (!u) throw new JobError('invalid_query_url', { status: 'failed' });
    if (hosts.length && !hostMatches(u.hostname, hosts)) throw new JobError('query_url_not_on_directory', { status: 'failed' });
    return u.href;
  }
  let tpl = null;
  if (query.category && cfg.category_url) tpl = cfg.category_url;
  else if ((query.keywords || query.category) && cfg.search_url) tpl = cfg.search_url;
  if (!tpl) throw new JobError('missing_payload_fields:query', { status: 'failed' });
  let url = String(render(tpl, vars));
  if (query.location && cfg.location_param && !query.url) {
    const u = absUrl(url);
    if (u) { u.searchParams.set(cfg.location_param, query.location); url = u.href; }
  }
  return url;
}

function pageUrlFor(firstUrl, cfg, pageIndex) {
  if (!cfg.page_param) return null;
  const u = absUrl(firstUrl);
  if (!u) return null;
  const start = Number.isFinite(Number(cfg.page_start)) ? Number(cfg.page_start) : 1;
  u.searchParams.set(String(cfg.page_param), String(start + pageIndex));
  return u.href;
}

// ---------------- raw rows → contract items ----------------

function normalizeItem(r, { base, hosts, sourceUrl }) {
  if (!r || typeof r !== 'object') return null;
  const name = clean(Array.isArray(r.name) ? r.name[0] : r.name, 300);
  if (!name) return null;
  const detailUrl = absUrl(r.detail_url ?? r.url ?? r.link ?? r.source_url, base);
  let linkedin = normalizeLinkedin(r.linkedin_url, base);
  if (!linkedin && detailUrl && /(^|\.)linkedin\.com$/i.test(detailUrl.hostname)) linkedin = normalizeLinkedin(detailUrl.href);
  const website = normalizeWebsite(r.website, { base, hosts });
  const extra = {};
  for (const [k, v] of Object.entries(r)) {
    if (ITEM_FIELDS.includes(k) || INTERNAL_FIELDS.includes(k) || v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { const arr = v.map((x) => clean(x, 300)).filter(Boolean); if (arr.length) extra[k] = arr.slice(0, 20); continue; }
    if (k === 'rating') { extra.rating = parseRating(v); continue; }
    if (COUNT_EXTRA.includes(k)) { extra[k] = parseCount(v); continue; }
    extra[k] = clean(v, 500);
  }
  const item = {
    name,
    website,
    domain: website ? normalizeDomain(website) : normalizeDomain(r.domain),
    description: clean(r.description, 1000),
    category: clean(Array.isArray(r.category) ? r.category.join(', ') : r.category, 300),
    location: clean(Array.isArray(r.location) ? r.location.join('; ') : r.location, 300),
    linkedin_url: linkedin,
    source_url: (detailUrl && hostMatches(detailUrl.hostname, hosts) ? detailUrl.href : null) || sourceUrl || null,
    extra,
  };
  if (!item.website && item.domain) item.website = `https://${item.domain}`;
  Object.defineProperty(item, '_detail_url', { value: detailUrl ? detailUrl.href : null, enumerable: false });
  return item;
}

function itemKey(item) {
  return (item.domain && `d:${item.domain}`) || (item.linkedin_url && `l:${item.linkedin_url.toLowerCase()}`)
    || (item._detail_url && `u:${item._detail_url}`) || `n:${item.name.toLowerCase()}`;
}

/** Merge detail-page fields into an item (detail wins only where the list row was empty). */
function mergeDetail(item, detail, { base, hosts }) {
  if (!detail || typeof detail !== 'object') return item;
  const website = normalizeWebsite(detail.website, { base, hosts });
  if (website && !item.website) { item.website = website; item.domain = normalizeDomain(website); }
  const li = normalizeLinkedin(detail.linkedin_url, base);
  if (li && !item.linkedin_url) item.linkedin_url = li;
  for (const k of ['description', 'category', 'location']) {
    const val = clean(Array.isArray(detail[k]) ? detail[k].join(', ') : detail[k], k === 'description' ? 1000 : 300);
    if (val && !item[k]) item[k] = val;
  }
  for (const [k, v] of Object.entries(detail)) {
    if (ITEM_FIELDS.includes(k) || INTERNAL_FIELDS.includes(k) || v === null || v === undefined || v === '' || k in item.extra) continue;
    if (k === 'rating') item.extra.rating = parseRating(v);
    else if (COUNT_EXTRA.includes(k)) item.extra[k] = parseCount(v);
    else item.extra[k] = Array.isArray(v) ? v.map((x) => clean(x, 300)).filter(Boolean).slice(0, 20) : clean(v, 500);
  }
  return item;
}

// ---------------- pacing ----------------

async function waitUntilAllowed(key, signal, progress) {
  const wait = Math.max(0, (nextAllowedAt.get(key) || 0) - Date.now());
  if (wait > 0) {
    if (progress) progress('pacing', `waiting ${Math.round(wait / 1000)}s between directory searches`);
    const behavior = require('../behavior');
    await behavior.sleep(wait, signal);
  }
  return wait;
}

function scheduleNext(key, gap) {
  const ms = (gap[0] + Math.random() * (gap[1] - gap[0])) * delayScale();
  nextAllowedAt.set(key, Date.now() + ms);
}

/** Map a blocked recipe / detector warning set to a stop reason. */
function blockReason(warnings) {
  const w = warnings || [];
  if (w.includes('captcha_detected') || w.includes('unusual_activity')) return 'captcha';
  return 'blocked';
}

// ---------------- job ----------------

module.exports = {
  // exported for tests
  DIRECTORIES,
  normalizeDomain,
  normalizeWebsite,
  normalizeLinkedin,
  normalizeItem,
  templateVars,
  _resetPacing: () => nextAllowedAt.clear(),

  type: 'scrape_directory',
  platform: (job) => (String(((job && job.payload) || {}).directory || '').trim().toLowerCase() === 'linkedin_search' ? 'linkedin' : 'web'),
  // linkedin_search: every LinkedIn page load = 1 action (LinkedIn daily limit 20). Public directories: none.
  category: (job) => (String(((job && job.payload) || {}).directory || '').trim().toLowerCase() === 'linkedin_search' ? 'actions' : 'none'),

  async run(ctx) {
    const { job, payload, behavior } = ctx;
    const directory = String(payload.directory || '').trim().toLowerCase();
    if (!directory) throw new JobError('missing_payload_fields:directory', { status: 'failed' });
    if (!DIRECTORIES.includes(directory)) throw new JobError(`unsupported_directory:${directory.slice(0, 40)}`, { status: 'failed' });
    const isLinkedin = directory === 'linkedin_search';
    if (isLinkedin && (!ctx.profile || ctx.profile.platform !== 'linkedin')) {
      throw new JobError('no_profile_for_platform:linkedin', { status: 'failed' });
    }
    requireRecipe(job);
    const steps = job.recipe.steps;
    const cfg = parseConfig(steps);
    const listSteps = phaseSteps(steps, 'list');
    const detailSteps = phaseSteps(steps, 'detail');
    if (!listSteps.length) throw new JobError('recipe_missing_list_steps', { status: 'failed' });
    const hosts = Array.isArray(cfg.hosts) ? cfg.hosts : [];

    const query = normalizeQuery(payload.query);
    const cap = isLinkedin ? LINKEDIN_LIMIT_CAP : LIMIT_CAP;
    const limit = Math.max(1, Math.min(cap, Math.round(Number(payload.limit) || DEFAULT_LIMIT)));
    const maxPages = Math.max(1, Math.min(isLinkedin ? LINKEDIN_MAX_PAGES_CAP : MAX_PAGES_CAP, Math.round(Number(cfg.max_pages) || 5)));
    const detailMode = ['always', 'missing_website', 'never'].includes(cfg.detail) ? cfg.detail : 'missing_website';
    const maxDetails = Math.max(0, Math.min(MAX_DETAILS_CAP, Math.round(Number(cfg.max_details ?? limit))));
    const pageDelay = range(cfg.page_delay_ms, DEFAULTS.page_delay_ms);
    const detailDelay = range(cfg.detail_delay_ms, DEFAULTS.detail_delay_ms);
    const jobGap = range(cfg.job_gap_ms, DEFAULTS.job_gap_ms);

    const vars = templateVars(directory, query, limit);
    const { renderString } = require('../recipe-executor');
    const firstUrl = startUrl(cfg, query, vars, renderString);

    // LinkedIn budget: remaining actions today on this profile (runner already checked ≥ 1).
    let budget = Infinity;
    if (isLinkedin && typeof ctx.quota === 'function') {
      const q = ctx.quota('actions');
      if (q && q.remaining !== null && q.remaining !== undefined) budget = q.remaining;
    }
    let actionsUsed = 0;
    const takeAction = () => {
      if (!isLinkedin) return true;
      if (actionsUsed >= budget) return false;
      actionsUsed += 1;
      return true;
    };

    const paceKey = `${(ctx.profile && ctx.profile.id) || 'web'}:${directory}`;
    const pacedMs = await waitUntilAllowed(paceKey, ctx.signal, ctx.progress);

    const items = [];
    const seen = new Set();
    const warnings = new Set();
    let pages = 0;
    let rawItems = 0;
    let stopped = null;
    let failedStep = null;
    let detailsVisited = 0;
    let url = firstUrl;

    try {
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        if (!takeAction()) { stopped = 'daily_limit'; break; }
        if (pageIndex > 0) await behavior.humanDelay(pageDelay[0], pageDelay[1], ctx.signal);
        if (ctx.progress) ctx.progress('page', `${directory} results page ${pageIndex + 1}`);
        let res;
        try {
          res = await ctx.runRecipe({ ...vars, page: pageIndex + 1, page_index: pageIndex, page_url: url, url },
            { ...job.recipe, steps: listSteps });
        } catch (err) {
          if (err && err.message === 'cancelled') throw err;
          if (err && err.blocked) {
            (err.warnings || []).forEach((w) => warnings.add(w));
            stopped = blockReason(err.warnings);
            failedStep = err.failed_step || null;
            if (!items.length) {
              const e = new JobError(err.message, { status: 'blocked', warnings: [...warnings], failed_step: failedStep });
              e.data = { directory, items: [], pages, stopped_reason: stopped };
              throw e;
            }
            break;
          }
          if (!items.length) throw err; // first page failed → failed job (recipe needs a fix)
          warnings.add('selector_failed');
          failedStep = (err && err.failed_step) || null;
          stopped = 'error';
          break;
        }
        pages += 1;
        let pageUrl = url;
        try { pageUrl = ctx.page.url() || url; } catch (_) { /* ignore */ }
        const raw = pickList(res.data, ['items', 'results', 'extract']);
        rawItems += raw.length;

        if (!raw.length) {
          // An empty page that is really a challenge page → captcha / blocked; otherwise end of list.
          const d = typeof ctx.detect === 'function' ? await ctx.detect().catch(() => null) : null;
          if (d && d.blocking) {
            d.warnings.forEach((w) => warnings.add(w));
            stopped = blockReason(d.warnings);
            if (!items.length) {
              const e = new JobError('challenge_detected', { status: 'blocked', warnings: [...warnings] });
              e.data = { directory, items: [], pages, stopped_reason: stopped };
              throw e;
            }
          } else {
            stopped = 'no_more_pages';
          }
          break;
        }

        let fresh = 0;
        for (const r of raw) {
          const item = normalizeItem(r, { base: pageUrl, hosts, sourceUrl: pageUrl });
          if (!item) continue;
          const key = itemKey(item);
          if (seen.has(key)) continue;
          seen.add(key);
          fresh += 1;
          items.push(item);
          if (items.length >= limit) break;
        }
        if (items.length >= limit) { stopped = 'limit_reached'; break; }
        if (!fresh) { stopped = 'no_more_pages'; break; }

        // Next page: explicit pager link wins; else the recipe's page parameter.
        const pager = pickObj(res.data, ['pager']);
        const hasPagerStep = listSteps.some((s) => s.save_as === 'pager');
        const nextLink = absUrl(pager.next_url, pageUrl);
        let next = null;
        if (nextLink && (!hosts.length || hostMatches(nextLink.hostname, hosts))) next = nextLink.href;
        else if (!hasPagerStep || cfg.page_param_always) next = pageUrlFor(firstUrl, cfg, pageIndex + 1);
        if (!next || next === pageUrl) { stopped = 'no_more_pages'; break; }
        url = next;
      }
      if (!stopped) stopped = items.length >= limit ? 'limit_reached' : 'no_more_pages';

      // Optional detail visits (website / LinkedIn / location), only for items that need them.
      if (detailSteps.length && detailMode !== 'never' && !['captcha', 'blocked'].includes(stopped)) {
        for (const item of items) {
          if (detailsVisited >= maxDetails) break;
          if (!item._detail_url || (detailMode === 'missing_website' && item.website)) continue;
          if (hosts.length && !hostMatches(hostOf(item._detail_url), hosts)) continue;
          if (!takeAction()) { stopped = 'daily_limit'; break; }
          await behavior.humanDelay(detailDelay[0], detailDelay[1], ctx.signal);
          detailsVisited += 1;
          try {
            const res = await ctx.runRecipe({ ...vars, detail_url: item._detail_url, url: item._detail_url },
              { ...job.recipe, steps: detailSteps });
            let base = item._detail_url;
            try { base = ctx.page.url() || base; } catch (_) { /* ignore */ }
            mergeDetail(item, pickObj(res.data, ['detail', 'extract']), { base, hosts });
          } catch (err) {
            if (err && err.message === 'cancelled') throw err;
            if (err && err.blocked) {
              (err.warnings || []).forEach((w) => warnings.add(w));
              stopped = blockReason(err.warnings);
              failedStep = err.failed_step || null;
              break;
            }
            warnings.add('detail_failed');
          }
        }
      }
    } finally {
      scheduleNext(paceKey, jobGap); // the directory saw requests either way
    }

    return {
      data: {
        directory,
        items: items.map((i) => ({ ...i })),
        pages,
        stopped_reason: stopped,
        _meta: {
          directory,
          limit,
          raw_items: rawItems,
          details_visited: detailsVisited,
          actions_used: isLinkedin ? actionsUsed : 0,
          paced_ms: Math.round(pacedMs),
          ...(failedStep ? { failed_step: failedStep } : {}),
        },
      },
      warnings: [...warnings],
      countAction: isLinkedin && actionsUsed > 0,
      actionCount: actionsUsed,
    };
  },
};
