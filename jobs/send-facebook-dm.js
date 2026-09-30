'use strict';
/**
 * send_facebook_dm
 * payload: { profile_url | handle, message, prospect_id? }
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'send_facebook_dm',
  platform: 'facebook',
  required: ['profile_url|handle', 'message'],
  maxLen: { message: 2000 },
  vars: (p) => {
    const url = p.profile_url || `https://www.facebook.com/${encodeURIComponent(String(p.handle).replace(/^@/, ''))}`;
    const m = /facebook\.com\/(?:profile\.php\?id=)?([^/?&#]+)/i.exec(url);
    return { profile_url: url, messenger_url: m ? `https://www.facebook.com/messages/t/${m[1]}` : url, message: String(p.message) };
  },
  result: (p) => ({ recipient: p.profile_url || p.handle, prospect_id: p.prospect_id || null }),
});
