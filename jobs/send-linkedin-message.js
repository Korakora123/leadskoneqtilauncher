'use strict';
/**
 * send_linkedin_message
 * payload: { profile_url, message, subject?, prospect_id? }
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'send_linkedin_message',
  platform: 'linkedin',
  required: ['profile_url', 'message'],
  maxLen: { message: 8000, subject: 200 },
  vars: (p) => ({ profile_url: p.profile_url, message: String(p.message), subject: p.subject || '' }),
  result: (p) => ({ recipient: p.profile_url, prospect_id: p.prospect_id || null }),
});
