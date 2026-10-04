'use strict';
/**
 * Static validation: loads every non-Electron module, syntax-checks Electron
 * modules, and verifies the job registry covers every job type in CONTRACTS.md §3.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
process.env.KONEQTI_DATA_DIR = process.env.KONEQTI_DATA_DIR || path.join(require('os').tmpdir(), 'koneqti-check');

const plain = [
  'store', 'logger', 'profile-manager', 'behavior', 'detection', 'recipe-executor', 'uploader',
  'auth', 'websocket-client', 'playwright-runner', 'browser/adapter', 'browser/fingerprint',
  'browser/engines/chromium-patched', 'browser/engines/cloakbrowser', 'browser/engines/camoufox', 'jobs',
];
const electron = ['main.js', 'preload.js', 'tray.js', 'renderer/renderer.js'];

const CONTRACT_JOB_TYPES = [
  'scrape_google_maps', 'scrape_instagram', 'scrape_linkedin', 'scrape_facebook_groups', 'scrape_tiktok',
  'scrape_job_posts', 'scrape_website', 'check_gbp', 'check_social_profile', 'send_instagram_dm',
  'send_linkedin_message', 'send_linkedin_connect', 'send_linkedin_voice_note', 'send_facebook_dm',
  'community_engage', 'content_like', 'capture_proof_screenshots', 'capture_video_frames', 'canary_routine',
  // DISPATCH_CONTRACTS.md §4
  'search_load_board',
];

let failed = 0;
for (const m of plain) {
  try {
    require(path.join(root, m));
    console.log(`ok   require ${m}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL require ${m}: ${err.message}`);
  }
}
for (const f of electron) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    console.log(`ok   syntax  ${f}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL syntax  ${f}: ${err.stderr || err.message}`);
  }
}
const { JOB_TYPES, JOBS } = require(path.join(root, 'jobs'));
const missing = CONTRACT_JOB_TYPES.filter((t) => !JOB_TYPES.includes(t));
const extra = JOB_TYPES.filter((t) => !CONTRACT_JOB_TYPES.includes(t));
if (missing.length || extra.length) {
  failed += 1;
  console.error(`FAIL job registry: missing=${missing.join(',')} extra=${extra.join(',')}`);
} else {
  console.log(`ok   job registry covers all ${CONTRACT_JOB_TYPES.length} contract job types`);
}
for (const [t, m] of Object.entries(JOBS)) {
  if (typeof m.run !== 'function') { failed += 1; console.error(`FAIL ${t} has no run()`); }
}
// No Electron imports in executor-agnostic code.
const fs = require('fs');
const agnostic = ['recipe-executor.js', 'playwright-runner.js', 'behavior.js', 'detection.js', 'uploader.js', 'websocket-client.js',
  'profile-manager.js', 'browser/adapter.js', ...fs.readdirSync(path.join(root, 'jobs')).map((f) => `jobs/${f}`)];
for (const f of agnostic) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  if (/require\(['"]electron['"]\)/.test(src)) { failed += 1; console.error(`FAIL ${f} imports electron`); }
}
console.log(failed ? `\n${failed} problem(s)` : '\nall checks passed');
process.exit(failed ? 1 : 0);
