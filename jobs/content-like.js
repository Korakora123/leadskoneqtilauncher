'use strict';
/**
 * content_like (warm path, Agent 17) — like a prospect's post.
 * payload: { platform, post_url, prospect_id? }
 * Recipe may save { state: { already_liked: true } } → job 'skipped'.
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'content_like',
  platform: (job) => job.platform || (job.payload && job.payload.platform) || 'linkedin',
  required: ['post_url'],
  vars: (p) => ({ post_url: p.post_url }),
  result: (p) => ({ liked: true, post_url: p.post_url, prospect_id: p.prospect_id || null }),
});
