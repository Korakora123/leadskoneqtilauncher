'use strict';
/**
 * scrape_tiktok — hashtag / profile / search scrape.
 * payload: { mode: 'hashtag'|'profile'|'search', hashtag?, handle?, query?, max_results?=20 }
 * recipe saves `profiles`/`profile` (handle, full_name, bio, followers, following, likes, external_url)
 * and `videos` (url, author, caption, views, likes, comments_count, date)
 */
const {
  requireRecipe, JobError, parseCount, relativeToIso, pickList, pickObj, clean,
  containsAny, DM_TO_ORDER, findWhatsappLinks,
} = require('./_helpers');

module.exports = {
  type: 'scrape_tiktok',
  platform: 'tiktok',
  category: 'views',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const mode = payload.mode || (payload.hashtag ? 'hashtag' : payload.handle ? 'profile' : 'search');
    const max = Math.max(1, Math.min(100, Number(payload.max_results) || 20));
    let url;
    if (mode === 'hashtag' && payload.hashtag) url = `https://www.tiktok.com/tag/${encodeURIComponent(String(payload.hashtag).replace(/^#/, ''))}`;
    else if (mode === 'profile' && payload.handle) url = `https://www.tiktok.com/@${encodeURIComponent(String(payload.handle).replace(/^@/, ''))}`;
    else if (mode === 'search' && payload.query) url = `https://www.tiktok.com/search?q=${encodeURIComponent(payload.query)}`;
    else throw new JobError('missing_payload_fields:hashtag|handle|query');

    const res = await ctx.runRecipe({ url, max_results: max, mode });
    const videos = pickList(res.data, ['videos', 'posts']).slice(0, max).map((v) => ({
      url: clean(v.url, 500),
      author: clean(v.author, 100),
      caption: clean(v.caption, 2200),
      views: parseCount(v.views),
      likes: parseCount(v.likes),
      comments_count: parseCount(v.comments_count),
      posted_at: relativeToIso(v.date),
    }));
    let profiles = pickList(res.data, ['profiles']);
    const single = pickObj(res.data, ['profile']);
    if (!profiles.length && Object.keys(single).length) profiles = [single];
    return {
      data: {
        mode,
        profiles: profiles.slice(0, max).map((p) => {
          const bio = clean(p.bio, 1000) || '';
          return {
            handle: clean(p.handle, 100)?.replace(/^@/, '') || null,
            full_name: clean(p.full_name, 200),
            bio,
            followers: parseCount(p.followers),
            following: parseCount(p.following),
            likes: parseCount(p.likes),
            external_url: clean(p.external_url, 500),
            dm_to_order: containsAny(bio, DM_TO_ORDER).length > 0,
            whatsapp_links: findWhatsappLinks(`${bio} ${p.external_url || ''}`),
          };
        }),
        videos,
      },
    };
  },
};
