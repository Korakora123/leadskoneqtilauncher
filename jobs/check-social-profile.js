'use strict';
/**
 * check_social_profile — follower count, last post date, engagement (milestones / viral detection).
 * payload: { platform: 'instagram'|'tiktok'|'linkedin'|'facebook', handle?, url? }
 * recipe vars added: url, handle
 * recipe saves `profile` { followers, following, posts_count, last_post_date }
 *          and `posts` (list) { url, likes, comments_count, views, date }
 */
const { requireRecipe, JobError, parseCount, relativeToIso, pickList, pickObj, clean } = require('./_helpers');
const { parseMetaCounts } = require('./scrape-instagram');

const PROFILE_URL = {
  instagram: (h) => `https://www.instagram.com/${h}/`,
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  facebook: (h) => `https://www.facebook.com/${h}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h}/`,
};

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = {
  type: 'check_social_profile',
  platform: (job) => job.platform || (job.payload && job.payload.platform) || 'instagram',
  category: 'views',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const platform = job.platform || payload.platform || 'instagram';
    const handle = payload.handle ? String(payload.handle).replace(/^@/, '') : null;
    const url = payload.url || (handle && PROFILE_URL[platform] ? PROFILE_URL[platform](encodeURIComponent(handle)) : null);
    if (!url) throw new JobError('missing_payload_fields:handle|url');

    const res = await ctx.runRecipe({ url, profile_url: url, handle: handle || '' });
    const p = pickObj(res.data, ['profile', 'extract']);
    const meta = parseMetaCounts(p.description);
    const followers = parseCount(p.followers) ?? meta.followers;
    const posts = pickList(res.data, ['posts', 'videos', 'extract_posts']).slice(0, 12).map((x) => {
      const likes = parseCount(x.likes) || 0;
      const comments = parseCount(x.comments_count) || 0;
      return {
        url: clean(x.url, 500),
        likes,
        comments_count: comments,
        views: parseCount(x.views),
        engagement: likes + comments,
        posted_at: relativeToIso(x.date),
      };
    });
    const engagements = posts.map((x) => x.engagement);
    const med = median(engagements);
    const avg = engagements.length ? engagements.reduce((a, b) => a + b, 0) / engagements.length : null;
    const viral = posts.filter((x) => med > 0 && x.engagement >= med * 10);
    const lastPostAt = relativeToIso(p.last_post_date)
      || posts.map((x) => x.posted_at).filter(Boolean).sort().reverse()[0] || null;
    return {
      data: {
        platform,
        handle,
        url,
        followers,
        following: parseCount(p.following) ?? meta.following,
        posts_count: parseCount(p.posts_count) ?? meta.posts,
        last_post_at: lastPostAt,
        avg_engagement: avg === null ? null : Math.round(avg),
        engagement_rate: avg !== null && followers ? Math.round((avg / followers) * 10000) / 10000 : null,
        median_engagement: med,
        viral_posts: viral,
        recent_posts: posts,
        checked_at: new Date().toISOString(),
      },
    };
  },
};
