'use strict';
/**
 * scrape_linkedin — profile / company / search scrape (fully recipe-driven).
 * payload: { mode: 'profile'|'company'|'search', url?, query?, max_results?=10 }
 * recipe vars added: url (search url when mode=search), max_results
 * recipe vars added: url, profile_url, company_url
 * recipe saves `profile` | `company` | `results` (list) — or a generic `extract` object (seeded recipe). Count-like fields
 * (followers, employees, connections, job_openings) are parsed to integers.
 */
const { requireRecipe, JobError, parseCount, pickList, pickObj } = require('./_helpers');

const COUNT_FIELDS = ['followers', 'employees', 'employee_count', 'connections', 'job_openings', 'open_jobs'];

function normalize(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of COUNT_FIELDS) if (k in out) out[k] = parseCount(out[k]);
  return out;
}

module.exports = {
  type: 'scrape_linkedin',
  platform: 'linkedin',
  category: 'views',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const mode = payload.mode || (payload.query ? 'search' : 'profile');
    const max = Math.max(1, Math.min(50, Number(payload.max_results) || 10));
    let url = payload.url;
    if (mode === 'search') {
      if (!payload.query && !url) throw new JobError('missing_payload_fields:query');
      url = url || `https://www.linkedin.com/search/results/${payload.search_type || 'people'}/?keywords=${encodeURIComponent(payload.query)}`;
    } else if (!url) {
      throw new JobError('missing_payload_fields:url');
    }
    const res = await ctx.runRecipe({ url, profile_url: url, company_url: url, max_results: max, limit: max, mode });
    const data = { mode, url };
    const generic = pickObj(res.data, ['extract']);
    const profile = pickObj(res.data, ['profile']);
    const company = pickObj(res.data, ['company']);
    if (Object.keys(generic).length && !Object.keys(profile).length && !Object.keys(company).length) {
      if (mode === 'company') Object.assign(company, generic); else Object.assign(profile, generic);
    }
    const results = pickList(res.data, ['results', 'people', 'companies']);
    if (Object.keys(profile).length) data.profile = normalize(profile);
    if (Object.keys(company).length) data.company = normalize(company);
    if (results.length) data.results = results.slice(0, max).map(normalize);
    return { data };
  },
};
