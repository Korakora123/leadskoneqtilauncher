'use strict';
/**
 * scrape_instagram — hashtag or profile scrape (creator / seller discovery).
 * payload: { mode: 'hashtag'|'profile', hashtag?, handle?, max_results?=20 }
 * recipe vars added: url, max_results
 * recipe saves `profiles` (list) or `profile`/`extract` (object): handle|username, full_name, bio, followers,
 *   following, posts_count, external_url|external_link, category, description (og meta → counts parsed)
 * and optionally `posts`/`extract_posts` (list): url, author, caption|alt, likes, comments_count, comments (all), date
 */
const {
  requireRecipe, JobError, parseCount, relativeToIso, pickList, pickObj, clean,
  containsAny, DM_TO_ORDER, PRICE_QUESTIONS, findWhatsappLinks,
} = require('./_helpers');

/** og/meta description: "1,234 Followers, 56 Following, 78 Posts - See Instagram photos…" */
function parseMetaCounts(desc) {
  const s = String(desc || '');
  const grab = (re) => { const m = re.exec(s); return m ? parseCount(m[1]) : null; };
  return {
    followers: grab(/([\d.,]+\s*[kKmM]?)\s+Followers/i),
    following: grab(/([\d.,]+\s*[kKmM]?)\s+Following/i),
    posts: grab(/([\d.,]+\s*[kKmM]?)\s+Posts/i),
  };
}

function normPost(p) {
  const comments = Array.isArray(p.comments) ? p.comments.map((c) => clean(c, 500)).filter(Boolean) : [];
  const priceQs = comments.filter((c) => containsAny(c, PRICE_QUESTIONS).length > 0).length;
  return {
    url: clean(p.url, 500),
    author: clean(p.author, 100),
    caption: clean(p.caption ?? p.alt, 2200),
    likes: parseCount(p.likes),
    comments_count: parseCount(p.comments_count) ?? (comments.length || null),
    price_questions: priceQs,
    posted_at: relativeToIso(p.date),
  };
}

function normProfile(p, posts) {
  const bio = clean(p.bio, 1000) || '';
  const meta = parseMetaCounts(p.description);
  if (!p.handle && p.username) p = { ...p, handle: p.username };
  const mine = posts.filter((x) => !x.author || !p.handle || x.author.replace(/^@/, '') === String(p.handle).replace(/^@/, ''));
  return {
    handle: clean(p.handle, 100)?.replace(/^@/, '') || null,
    full_name: clean(p.full_name, 200),
    bio,
    category: clean(p.category, 100),
    followers: parseCount(p.followers) ?? meta.followers,
    following: parseCount(p.following) ?? meta.following,
    posts_count: parseCount(p.posts_count) ?? meta.posts,
    external_url: clean(p.external_url ?? p.external_link, 500),
    dm_to_order: containsAny(`${bio} ${mine.map((x) => x.caption).join(' ')}`, DM_TO_ORDER).length > 0,
    whatsapp_links: findWhatsappLinks(`${bio} ${p.external_url || p.external_link || ''}`),
    price_question_count: mine.reduce((s, x) => s + x.price_questions, 0),
    recent_posts: mine.slice(0, 12),
  };
}

module.exports = {
  type: 'scrape_instagram',
  parseMetaCounts,
  platform: 'instagram',
  category: 'views',
  normPost,
  normProfile,
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const mode = payload.mode || (payload.hashtag ? 'hashtag' : 'profile');
    const max = Math.max(1, Math.min(100, Number(payload.max_results) || 20));
    let url;
    let handle = '';
    if (mode === 'hashtag') {
      if (!payload.hashtag) throw new JobError('missing_payload_fields:hashtag');
      url = `https://www.instagram.com/explore/tags/${encodeURIComponent(String(payload.hashtag).replace(/^#/, ''))}/`;
    } else {
      if (!payload.handle) throw new JobError('missing_payload_fields:handle');
      handle = String(payload.handle).replace(/^@/, '');
      url = `https://www.instagram.com/${encodeURIComponent(String(payload.handle).replace(/^@/, ''))}/`;
    }
    const res = await ctx.runRecipe({ url, handle, max_results: max, limit: max, mode });
    const posts = pickList(res.data, ['posts', 'extract_posts']).map(normPost);
    let profiles = pickList(res.data, ['profiles']);
    const single = pickObj(res.data, ['profile', 'extract']);
    if (!profiles.length && Object.keys(single).length) profiles = [single];
    return {
      data: {
        mode,
        hashtag: payload.hashtag || null,
        handle: payload.handle || null,
        profiles: profiles.slice(0, max).map((p) => normProfile(p, posts)),
        posts: posts.slice(0, max),
      },
    };
  },
};
