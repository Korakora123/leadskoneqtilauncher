'use strict';
/**
 * Factory for outreach "action" jobs (DMs, connects, comments, likes).
 * Every action job: recipe required, validates payload, counts 1 action on success,
 * returns { sent: true, ... , sent_at }. The message text is never logged.
 */
const { requireRecipe, JobError, pickObj } = require('./_helpers');

/**
 * @param {object} def
 * @param {string} def.type
 * @param {string|function} def.platform
 * @param {string[]} def.required            payload fields that must be present
 * @param {{[field:string]:number}} [def.maxLen]
 * @param {(payload:object)=>object} [def.vars]  extra recipe vars
 * @param {(payload:object, recipeData:object)=>object} [def.result]
 */
function makeActionJob(def) {
  return {
    type: def.type,
    platform: def.platform,
    category: 'actions',
    async run(ctx) {
      const { job, payload } = ctx;
      requireRecipe(job);
      for (const f of def.required) {
        const any = f.split('|');
        if (!any.some((k) => payload[k] !== undefined && payload[k] !== null && String(payload[k]).trim() !== '')) {
          throw new JobError(`missing_payload_fields:${f}`);
        }
      }
      for (const [f, max] of Object.entries(def.maxLen || {})) {
        if (payload[f] && String(payload[f]).length > max) throw new JobError(`${f}_too_long:max_${max}`);
      }
      const vars = def.vars ? await def.vars(payload, ctx) : {};
      const res = await ctx.runRecipe(vars);
      const state = pickObj(res.data, ['state', 'status']);
      // Recipes may report e.g. { state: { already_connected: true } } → nothing was sent.
      if (state.already_connected || state.already_sent || state.already_liked || state.cannot_message) {
        const err = new JobError(['already_connected', 'already_sent', 'already_liked', 'cannot_message'].find((k) => Boolean(state[k])) || 'not_sent', { status: 'skipped' });
        err.data = { sent: false, state };
        throw err;
      }
      const base = { sent: true, sent_at: new Date().toISOString(), platform: typeof def.platform === 'function' ? def.platform(job) : def.platform };
      return { data: { ...base, ...(def.result ? def.result(payload, res.data) : {}) }, countAction: true };
    },
  };
}

module.exports = { makeActionJob };
