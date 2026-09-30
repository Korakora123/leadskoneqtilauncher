'use strict';
/**
 * send_instagram_dm
 * payload: { handle, message, prospect_id? }
 * recipe vars added: profile_url, handle, message
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'send_instagram_dm',
  platform: 'instagram',
  required: ['handle', 'message'],
  maxLen: { message: 1000 },
  vars: (p) => {
    const handle = String(p.handle).replace(/^@/, '');
    return { handle, profile_url: `https://www.instagram.com/${encodeURIComponent(handle)}/`, message: String(p.message) };
  },
  result: (p) => ({ recipient: String(p.handle).replace(/^@/, ''), prospect_id: p.prospect_id || null }),
});
