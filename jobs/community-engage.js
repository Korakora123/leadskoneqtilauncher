'use strict';
/**
 * community_engage (warm path, Agent 17) — a genuine comment on a prospect's post.
 * payload: { platform, post_url, comment, prospect_id? }
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'community_engage',
  platform: (job) => job.platform || (job.payload && job.payload.platform) || 'linkedin',
  required: ['post_url', 'comment'],
  maxLen: { comment: 1250 },
  vars: (p) => ({ post_url: p.post_url, comment: String(p.comment) }),
  result: (p) => ({ commented: true, post_url: p.post_url, prospect_id: p.prospect_id || null }),
});
