'use strict';
/**
 * send_linkedin_connect (warm path) — connection request with optional note (≤ 300 chars).
 * payload: { profile_url, note?, prospect_id? }
 * Recipe may save { state: { already_connected: true } } or { state: { already_sent: true } } → job 'skipped'.
 */
const { makeActionJob } = require('./_send');

module.exports = makeActionJob({
  type: 'send_linkedin_connect',
  platform: 'linkedin',
  required: ['profile_url'],
  maxLen: { note: 300 },
  vars: (p) => ({ profile_url: p.profile_url, note: p.note ? String(p.note) : '', has_note: p.note ? 'yes' : '' }),
  result: (p) => ({ requested: true, with_note: Boolean(p.note), recipient: p.profile_url, prospect_id: p.prospect_id || null }),
});
