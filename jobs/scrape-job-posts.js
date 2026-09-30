'use strict';
/**
 * scrape_job_posts — job boards / careers pages / LinkedIn Jobs.
 * Feeds hiring_admin_ops, hiring_sales_rep, order_booker_hiring, compliance_job_post, tool_sprawl signals.
 *
 * payload: { urls?: string[], url?, query?, location?, source?: 'linkedin'|'indeed'|'careers_page'|string,
 *            keywords?: string[], max_results?=25, fetch_details?: boolean }
 * With a recipe: runs once per url (var `url`, plus query/location); recipe saves list `jobs`
 *   { title, company, location, description, date, url }.
 * Without a recipe: generic extraction of schema.org JobPosting JSON-LD (most job boards
 *   and ATS careers pages publish it) — no platform-specific selectors stored locally.
 */
const { JobError, relativeToIso, pickList, clean, containsAny } = require('./_helpers');

async function jsonLdJobs(page) {
  return page.evaluate(() => {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const t = node['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
        const org = node.hiringOrganization || {};
        const loc = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
        const addr = (loc && loc.address) || {};
        const div = document.createElement('div');
        div.innerHTML = String(node.description || '');
        out.push({
          title: node.title || null,
          company: typeof org === 'string' ? org : org.name || null,
          location: [addr.addressLocality, addr.addressRegion, addr.addressCountry && (addr.addressCountry.name || addr.addressCountry)]
            .filter(Boolean).join(', ') || null,
          description: div.innerText || div.textContent || '',
          date: node.datePosted || null,
          url: node.url || location.href,
          employment_type: node.employmentType || null,
        });
      }
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') visit(v); });
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { visit(JSON.parse(s.textContent)); } catch (e) { /* ignore */ }
    });
    return out;
  });
}

module.exports = {
  type: 'scrape_job_posts',
  platform: (job) => (job.platform || (job.payload && job.payload.source === 'linkedin' ? 'linkedin' : 'web')),
  category: (job) => ((job.platform || (job.payload && job.payload.source)) === 'linkedin' ? 'views' : 'none'),
  async run(ctx) {
    const { job, payload, page } = ctx;
    const max = Math.max(1, Math.min(100, Number(payload.max_results) || 25));
    const keywords = (payload.keywords || []).map(String).filter(Boolean);
    let urls = (Array.isArray(payload.urls) ? payload.urls : [payload.url]).filter(Boolean).slice(0, 10);
    if (!urls.length && payload.query && payload.source === 'linkedin') {
      urls = [`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(payload.query)}${payload.location ? `&location=${encodeURIComponent(payload.location)}` : ''}`];
    }
    if (!urls.length) throw new JobError('missing_payload_fields:urls');

    const jobs = [];
    const failed = [];
    for (let i = 0; i < urls.length && jobs.length < max; i += 1) {
      const url = urls[i];
      ctx.progress(`url_${i + 1}`, `page ${i + 1}/${urls.length}`);
      try {
        let rows = [];
        if (job.recipe && Array.isArray(job.recipe.steps) && job.recipe.steps.length) {
          const res = await ctx.runRecipe({ url, query: payload.query || '', location: payload.location || '' });
          rows = pickList(res.data, ['jobs', 'results']);
        } else {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
          await ctx.behavior.humanDelay(1500, 3500, ctx.signal);
          await ctx.behavior.humanScroll(page, { times: 2, signal: ctx.signal });
          rows = await jsonLdJobs(page);
        }
        for (const r of rows) {
          const title = clean(r.title, 300);
          if (!title) continue;
          const description = clean(r.description, 8000);
          const matched = keywords.length ? containsAny(`${title} ${description || ''}`, keywords) : [];
          if (keywords.length && !matched.length) continue;
          jobs.push({
            title,
            company: clean(r.company, 300),
            location: clean(r.location, 300),
            description,
            posted_at_text: clean(r.date, 80),
            posted_at: relativeToIso(r.date),
            url: clean(r.url, 1000) || url,
            employment_type: clean(Array.isArray(r.employment_type) ? r.employment_type.join(',') : r.employment_type, 100),
            source: payload.source || (url.includes('linkedin.com') ? 'linkedin' : 'web'),
            source_url: url,
            matched_keywords: matched,
          });
          if (jobs.length >= max) break;
        }
      } catch (err) {
        if (err && err.message === 'cancelled') throw err;
        failed.push({ url, error: err.message });
        const d = await ctx.detect();
        if (err.blocked || d.blocking) throw err;
      }
      if (i < urls.length - 1) await ctx.behavior.humanDelay(3000, 9000, ctx.signal);
    }
    if (!jobs.length && failed.length === urls.length) throw new JobError(failed[0].error || 'all_urls_failed');
    return { data: { count: jobs.length, jobs, failed_urls: failed } };
  },
};
