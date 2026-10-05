'use strict';
/**
 * Job registry — maps every job type in CONTRACTS.md §3 (+ DISPATCH_CONTRACTS.md §4) to its module.
 *
 * Job module interface (executor-agnostic, no Electron imports):
 *   {
 *     type: string,
 *     platform: string | (job) => string,          // 'web' = no login needed
 *     category: 'none'|'views'|'actions' | (job) => string,  // what counts toward daily limits
 *     run(ctx): Promise<{ data: object, warnings?: string[], countAction?: boolean }>
 *   }
 * ctx = { job, payload, page, browser, profile, runRecipe(vars), progress(step,msg),
 *         upload(files, meta), download(url), detect(), behavior, signal, log }
 */
const modules = [
  require('./scrape-google-maps'),
  require('./scrape-instagram'),
  require('./scrape-linkedin'),
  require('./scrape-facebook-groups'),
  require('./scrape-tiktok'),
  require('./scrape-job-posts'),
  require('./scrape-website'),
  require('./check-gbp'),
  require('./check-social-profile'),
  require('./send-instagram-dm'),
  require('./send-linkedin-message'),
  require('./send-linkedin-connect'),
  require('./send-linkedin-voice-note'),
  require('./send-facebook-dm'),
  require('./community-engage'),
  require('./content-like'),
  require('./capture-proof-screenshots'),
  require('./capture-video-frames'),
  require('./canary-routine'),
  require('./search-load-board'), // Dispatch OS (DISPATCH_CONTRACTS.md §4)
  require('./scrape-directory'), // Buyer sources Electron fallback (V2_API_INTEGRATIONS_CONTRACTS.md §8)
];

const JOBS = Object.fromEntries(modules.map((m) => [m.type, m]));

const JOB_TYPES = Object.keys(JOBS);

function getJob(type) {
  return JOBS[type] || null;
}

function platformOf(mod, job) {
  return typeof mod.platform === 'function' ? mod.platform(job) : mod.platform;
}

function categoryOf(mod, job) {
  return typeof mod.category === 'function' ? mod.category(job) : mod.category;
}

module.exports = { JOBS, JOB_TYPES, getJob, platformOf, categoryOf };
