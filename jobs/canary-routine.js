'use strict';
/**
 * canary_routine (Agent 18 canary system) — a normal browsing routine on a canary profile
 * (feed scroll, open messages) that reports any challenge. The runner's challenge detector
 * turns captcha / unusual activity / restriction into status 'blocked' + account_event.
 * payload: { platform, routine?: 'feed'|'messages'|'both' }
 * recipe: optional; without one a generic home-feed + inbox visit is used.
 */
const { detectChallenges } = require('../detection');

const HOME = {
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
  tiktok: 'https://www.tiktok.com/foryou',
};
const INBOX = {
  instagram: 'https://www.instagram.com/direct/inbox/',
  linkedin: 'https://www.linkedin.com/messaging/',
  facebook: 'https://www.facebook.com/messages/',
  tiktok: 'https://www.tiktok.com/messages',
};

module.exports = {
  type: 'canary_routine',
  platform: (job) => job.platform || (job.payload && job.payload.platform) || 'linkedin',
  category: 'none',
  async run(ctx) {
    const { job, payload, page, behavior } = ctx;
    const platform = job.platform || payload.platform || 'linkedin';
    const routine = payload.routine || 'both';
    const visited = [];
    if (job.recipe && Array.isArray(job.recipe.steps) && job.recipe.steps.length) {
      await ctx.runRecipe({ home_url: HOME[platform] || '', inbox_url: INBOX[platform] || '' });
      visited.push('recipe');
    } else {
      if (routine !== 'messages' && HOME[platform]) {
        await page.goto(HOME[platform], { waitUntil: 'domcontentloaded' });
        await behavior.humanDelay(2000, 5000, ctx.signal);
        await behavior.humanScroll(page, { times: Math.round(behavior.rand(3, 7)), signal: ctx.signal });
        visited.push('feed');
      }
      if (routine !== 'feed' && INBOX[platform]) {
        await behavior.humanDelay(2000, 6000, ctx.signal);
        await page.goto(INBOX[platform], { waitUntil: 'domcontentloaded' });
        await behavior.humanDelay(3000, 7000, ctx.signal);
        visited.push('messages');
      }
    }
    const d = await detectChallenges(page, { platform });
    return {
      data: {
        platform,
        visited,
        logged_in: !d.warnings.includes('logged_out'),
        challenges: d.warnings,
        healthy: d.warnings.length === 0,
        checked_at: new Date().toISOString(),
      },
    };
  },
};
