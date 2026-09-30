'use strict';
/**
 * scrape_facebook_groups — recent posts in given groups matching keywords
 * (lead_flow_complaint, dispatch_workload, "need dispatcher", ...).
 * payload: { group_urls: string[], keywords?: string[], max_posts_per_group?=30 }
 * recipe runs once PER GROUP with var group_url; saves list `posts`
 *   { author, author_url, text, date, url }
 */
const { requireRecipe, JobError, relativeToIso, pickList, clean, containsAny } = require('./_helpers');

module.exports = {
  type: 'scrape_facebook_groups',
  platform: 'facebook',
  category: 'views',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const groups = (Array.isArray(payload.group_urls) ? payload.group_urls : [payload.group_url]).filter(Boolean).slice(0, 10);
    if (!groups.length) throw new JobError('missing_payload_fields:group_urls');
    const keywords = (payload.keywords || []).map(String).filter(Boolean);
    const maxPer = Math.max(1, Math.min(100, Number(payload.max_posts_per_group) || 30));
    const posts = [];
    const failedGroups = [];
    for (let i = 0; i < groups.length; i += 1) {
      const groupUrl = groups[i];
      ctx.progress(`group_${i + 1}`, `group ${i + 1}/${groups.length}`);
      try {
        const res = await ctx.runRecipe({ group_url: groupUrl, max_posts: maxPer });
        for (const p of pickList(res.data, ['posts']).slice(0, maxPer)) {
          const text = clean(p.text, 5000);
          if (!text) continue;
          const matched = keywords.length ? containsAny(text, keywords) : [];
          if (keywords.length && !matched.length) continue;
          posts.push({
            group_url: groupUrl,
            author: clean(p.author, 200),
            author_url: clean(p.author_url, 500),
            text,
            posted_at_text: clean(p.date, 80),
            posted_at: relativeToIso(p.date),
            url: clean(p.url, 500),
            matched_keywords: matched,
          });
        }
      } catch (err) {
        if (err && err.message === 'cancelled') throw err;
        failedGroups.push({ group_url: groupUrl, error: err.message, failed_step: err.failed_step || null });
        const d = await ctx.detect();
        if (err.blocked || d.blocking) throw err; // challenge/block on page → stop, runner reports 'blocked'
      }
      if (i < groups.length - 1) await ctx.behavior.humanDelay(8000, 25000, ctx.signal);
    }
    if (!posts.length && failedGroups.length === groups.length) {
      throw new JobError(failedGroups[0].error || 'all_groups_failed', { failed_step: failedGroups[0].failed_step });
    }
    return { data: { groups_checked: groups.length - failedGroups.length, failed_groups: failedGroups, posts } };
  },
};
