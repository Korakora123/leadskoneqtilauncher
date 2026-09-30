'use strict';
/**
 * Recipe executor.
 *
 * Recipes (selectors + ordered steps) live ONLY on the brain. Each `job` message
 * carries `recipe: { id, version, steps }`; this module executes it and the recipe
 * is discarded afterwards — it is never written to disk.
 *
 * Step shape (all string params support `{{var}}` / `{{a.b}}` templating from job.payload):
 *   { id, action, selectors?: string[], selector?: string, goal?: string,
 *     optional?: boolean, no_ai?: boolean, timeout_ms?: number, nth?: number, ...action params }
 *
 * Actions:
 *   goto         { url, wait_until?: 'load'|'domcontentloaded'|'networkidle' }
 *   click        { selectors }
 *   type         { selectors, value, clear?: boolean, press_enter?: boolean }
 *   wait_for     { selectors?, state?: 'visible'|'attached'|'hidden', url_includes?, ms? }
 *   scroll       { selectors? (container), times?: number, until_count?: { selector, count } }
 *   extract      { list_selector?, fields: { name: css | {selector(s), attr?, multiple?, regex?, html?} }, save_as?, limit? }
 *   screenshot   { selectors? (element), full_page?: boolean, name? }
 *   press        { key, selectors? (focus first) }
 *   delay        { ms? | min_ms, max_ms }
 *   upload_file  { selectors (input[type=file] or a button opening a file chooser), file }
 *   check_text   { texts: string[], expect?: 'present'|'absent', selectors? (scope), warning? }
 *   hover        { selectors }
 *
 * Step flags (seeded recipes, supabase/seeds/automation_recipes.sql):
 *   optional      failure is recorded in skipped_steps and the recipe continues
 *   only_if       "{{var}}" — step is skipped when it renders empty / false
 *   skip_if_done  "<step id>" — step is skipped when that step already succeeded
 *   human         type per-char with human timing (default: on when humanizing)
 *   on_match      "abort_blocked" on check_text: if any phrase is PRESENT → job status 'blocked'
 * Aliases accepted: type.text (= value), check_text.phrases (= texts), scroll.target (= selectors),
 * scroll.until_text, extract field attr "text" (= inner text) and all: true (= multiple);
 * numeric params (times, limit, timeout_ms) may be template strings like "{{max_results}}".
 *
 * Selector-based steps try selectors in order. If all fail → AI fallback:
 * a compact accessibility tree (~15KB) is sent to the brain (`ai_selector_request`),
 * the brain answers with one selector (`ai_selector_response`, 30s timeout), and the
 * step is retried ONCE with it. Otherwise the recipe fails with `failed_step`.
 *
 * Pure Playwright + Node — no Electron imports.
 */
const behavior = require('./behavior');

const MAX_TREE_CHARS = 15000;
const AI_TIMEOUT_MS = 30000;

class RecipeError extends Error {
  constructor(message, { failed_step = null, warnings = [], partial = null, blocked = false } = {}) {
    super(message);
    this.name = 'RecipeError';
    this.blocked = blocked;
    this.failed_step = failed_step;
    this.warnings = warnings;
    this.partial = partial;
  }
}

// ---------------- templating ----------------

function lookup(vars, pathStr) {
  return String(pathStr).trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), vars);
}

function renderString(str, vars) {
  if (typeof str !== 'string') return str;
  const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(str);
  if (whole) {
    const v = lookup(vars, whole[1]);
    return v === undefined || v === null ? '' : v;
  }
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
    const v = lookup(vars, k);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function render(value, vars) {
  if (typeof value === 'string') return renderString(value, vars);
  if (Array.isArray(value)) return value.map((v) => render(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Field definitions inside extract are selectors — still templated (harmless).
      out[k] = render(v, vars);
    }
    return out;
  }
  return value;
}

function isEmptyFlag(v) {
  if (v === null || v === undefined || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  const t = String(v).trim().toLowerCase();
  return t === '' || t === 'false' || t === 'null' || t === 'undefined' || t === '0';
}

/** Numeric param that may arrive as a template string ("{{max_results}}" → "20"). */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== null ? n : fallback;
}

function selectorsOf(step) {
  const list = [];
  if (Array.isArray(step.selectors)) list.push(...step.selectors);
  if (typeof step.selector === 'string') list.push(step.selector);
  if (Array.isArray(step.target)) list.push(...step.target);
  else if (typeof step.target === 'string') list.push(step.target);
  return list.filter((s) => typeof s === 'string' && s.trim());
}

// ---------------- accessibility tree for AI fallback ----------------

async function buildAccessibilityTree(page) {
  let aria = '';
  try {
    const body = page.locator('body');
    if (typeof body.ariaSnapshot === 'function') {
      aria = await body.ariaSnapshot({ timeout: 5000 });
    } else if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
      aria = JSON.stringify(await page.accessibility.snapshot({ interestingOnly: true }));
    }
  } catch (_) { /* fall back to DOM outline */ }

  let outline = '';
  try {
    outline = await page.evaluate(() => {
      const sel = 'a,button,input,textarea,select,[role],[contenteditable="true"],[aria-label],h1,h2,h3,label';
      const lines = [];
      const els = Array.from(document.querySelectorAll(sel)).slice(0, 400);
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const attrs = [];
        if (el.id) attrs.push(`#${el.id}`);
        for (const a of ['role', 'aria-label', 'name', 'type', 'placeholder', 'data-testid', 'title']) {
          const v = el.getAttribute(a);
          if (v) attrs.push(`${a}="${v.slice(0, 60)}"`);
        }
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        lines.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} ${attrs.join(' ')}${text ? ` "${text}"` : ''}`);
      }
      return lines.join('\n');
    });
  } catch (_) { /* ignore */ }

  let url = '';
  try { url = page.url(); } catch (_) { /* ignore */ }
  const head = `URL: ${url}\n`;
  const ariaPart = aria ? `ARIA:\n${String(aria).slice(0, 9000)}\n` : '';
  const room = Math.max(1000, MAX_TREE_CHARS - head.length - ariaPart.length - 10);
  const domPart = outline ? `DOM:\n${outline.slice(0, room)}` : '';
  return `${head}${ariaPart}${domPart}`.slice(0, MAX_TREE_CHARS);
}

// ---------------- executor ----------------

/**
 * @param {import('playwright-core').Page} page
 * @param {{id?:string, version?:number, steps:object[]}} recipe
 * @param {object} [opts]
 * @param {object} [opts.vars]              template variables (job.payload + extras)
 * @param {(req:{step_id:string, goal:string, accessibility_tree:string})=>Promise<string|null>} [opts.requestSelector]
 * @param {(stepId:string, message:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.humanize=true]
 * @returns {Promise<{data:object, screenshots:{name:string, buffer:Buffer}[], skipped_steps:string[], ai_selectors_used:{step_id:string, selector:string}[], steps_completed:number}>}
 */
async function executeRecipe(page, recipe, opts = {}) {
  if (!recipe || !Array.isArray(recipe.steps)) throw new RecipeError('recipe_missing_or_invalid');
  const vars = opts.vars || {};
  const signal = opts.signal;
  const humanize = opts.humanize !== false;
  const result = { data: {}, screenshots: [], skipped_steps: [], ai_selectors_used: [], steps_completed: 0 };
  const succeeded = new Set();

  for (let i = 0; i < recipe.steps.length; i += 1) {
    if (signal && signal.aborted) throw new RecipeError('cancelled', { partial: result });
    const raw = recipe.steps[i] || {};
    const step = render(raw, vars);
    step.id = step.id || `step_${i + 1}`;
    if (step.only_if !== undefined && isEmptyFlag(step.only_if)) {
      result.skipped_steps.push(step.id);
      continue;
    }
    if (step.skip_if_done && succeeded.has(String(step.skip_if_done))) {
      result.skipped_steps.push(step.id);
      continue;
    }
    if (opts.onProgress) {
      try { opts.onProgress(step.id, step.action); } catch (_) { /* ignore */ }
    }
    try {
      await runStep(page, step, { ...opts, result, vars, humanize });
      result.steps_completed += 1;
      succeeded.add(step.id);
    } catch (err) {
      if (err && err.message === 'cancelled') throw new RecipeError('cancelled', { partial: result });
      if (step.optional && !(err && err.blocked)) {
        result.skipped_steps.push(step.id);
        continue;
      }
      if (err instanceof RecipeError) {
        err.partial = result;
        if (!err.failed_step) err.failed_step = step.id;
        throw err;
      }
      throw new RecipeError(err && err.message ? err.message : 'step_failed', {
        failed_step: step.id,
        warnings: [],
        partial: result,
      });
    }
    if (humanize && !step.no_delay && step.action !== 'delay') await behavior.humanDelay(250, 1100, signal);
  }
  return result;
}

/** Find the first working selector; AI fallback on total failure. Returns a Locator. */
async function resolveLocator(page, step, ctx, { state = 'visible' } = {}) {
  const list = selectorsOf(step);
  const total = num(step.timeout_ms, 15000);
  const per = Math.max(2500, Math.floor(total / Math.max(1, list.length)));
  for (const sel of list) {
    try {
      let loc = page.locator(sel);
      loc = Number.isInteger(step.nth) ? loc.nth(step.nth) : loc.first();
      await loc.waitFor({ state, timeout: per });
      return loc;
    } catch (_) { /* try next */ }
  }
  // AI fallback
  if (ctx.requestSelector && !step.no_ai && !step.optional) {
    try {
      const tree = await buildAccessibilityTree(page);
      const goal = step.goal || `${step.action} ${list.join(' | ')}`.slice(0, 300);
      const aiSel = await withTimeout(
        ctx.requestSelector({ step_id: step.id, goal, accessibility_tree: tree }),
        AI_TIMEOUT_MS,
      );
      if (aiSel && typeof aiSel === 'string') {
        const loc = page.locator(aiSel).first();
        await loc.waitFor({ state, timeout: Math.max(5000, per) });
        ctx.result.ai_selectors_used.push({ step_id: step.id, selector: aiSel });
        return loc;
      }
    } catch (_) { /* fall through */ }
  }
  throw new RecipeError('selector_failed', { failed_step: step.id, warnings: ['selector_failed'] });
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

async function runStep(page, step, ctx) {
  const { signal, humanize } = ctx;
  switch (step.action) {
    case 'goto': {
      if (!step.url) throw new RecipeError('goto_missing_url', { failed_step: step.id });
      await page.goto(String(step.url), { waitUntil: step.wait_until || 'domcontentloaded', timeout: num(step.timeout_ms, 45000) });
      if (humanize) await behavior.humanDelay(1200, 3200, signal);
      return;
    }
    case 'click': {
      const loc = await resolveLocator(page, step, ctx);
      if (humanize) await behavior.humanClick(loc, { signal });
      else await loc.click();
      return;
    }
    case 'hover': {
      const loc = await resolveLocator(page, step, ctx);
      await loc.hover();
      return;
    }
    case 'type': {
      const loc = await resolveLocator(page, step, ctx);
      const raw = step.value !== undefined ? step.value : step.text;
      const value = raw == null ? '' : String(raw);
      if (step.clear) {
        await loc.fill('').catch(() => {});
      }
      const human = step.human !== undefined ? Boolean(step.human) : humanize;
      if (human) await behavior.humanType(loc, value, { signal, newlineKey: step.newline_key });
      else await loc.fill(value);
      if (step.press_enter) {
        if (humanize) await behavior.humanDelay(300, 900, signal);
        await page.keyboard.press('Enter');
      }
      return;
    }
    case 'press': {
      if (selectorsOf(step).length) {
        const loc = await resolveLocator(page, step, ctx);
        await loc.focus();
      }
      await page.keyboard.press(String(step.key || 'Enter'));
      return;
    }
    case 'wait_for': {
      if (step.ms) {
        await behavior.sleep(Number(step.ms), signal);
        return;
      }
      if (step.url_includes) {
        await page.waitForURL((u) => String(u).includes(String(step.url_includes)), { timeout: num(step.timeout_ms, 20000) });
        return;
      }
      await resolveLocator(page, step, ctx, { state: step.state || 'visible' });
      return;
    }
    case 'delay': {
      if (step.ms) await behavior.sleep(Number(step.ms), signal);
      else await behavior.humanDelay(Number(step.min_ms) || 500, Number(step.max_ms) || 1500, signal);
      return;
    }
    case 'scroll': {
      let container = null;
      if (selectorsOf(step).length) {
        try {
          container = await resolveLocator(page, { ...step, no_ai: true }, ctx, { state: 'attached' });
        } catch (_) {
          container = null;
        }
      }
      const times = Math.max(1, Math.min(200, num(step.times, 3)));
      const untilText = step.until_text ? String(step.until_text).toLowerCase() : null;
      let lastCount = -1;
      let stale = 0;
      for (let n = 0; n < times; n += 1) {
        await behavior.humanScroll(page, { times: 1, container, signal });
        if (untilText) {
          const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
          if (String(txt).toLowerCase().includes(untilText)) break;
        }
        if (step.until_count && step.until_count.selector) {
          const c = await page.locator(step.until_count.selector).count().catch(() => 0);
          if (c >= Number(step.until_count.count || Infinity)) break;
          if (c === lastCount) stale += 1; else stale = 0;
          lastCount = c;
          if (stale >= 3) break; // nothing new loads
        }
      }
      return;
    }
    case 'extract': {
      const key = step.save_as || step.id;
      const fields = step.fields || {};
      const limit = Math.max(1, num(step.limit, 500));
      if (step.list_selector) {
        const items = await page.locator(step.list_selector).all();
        const out = [];
        for (const item of items.slice(0, limit)) {
          if (signal && signal.aborted) throw new Error('cancelled');
          // eslint-disable-next-line no-await-in-loop
          const row = await item.evaluate(extractFields, fields).catch(() => null);
          if (row) out.push(row);
        }
        // An empty list is a legitimate result (no businesses / private account) unless required.
        if (!out.length && step.require_items) {
          throw new RecipeError('extract_empty', { failed_step: step.id, warnings: ['selector_failed'] });
        }
        ctx.result.data[key] = out;
      } else {
        const row = await page.locator(':root').evaluate(extractFields, fields);
        ctx.result.data[key] = row;
      }
      return;
    }
    case 'screenshot': {
      const name = step.name || step.id;
      let buffer;
      if (selectorsOf(step).length) {
        const loc = await resolveLocator(page, step, ctx, { state: 'visible' });
        buffer = await loc.screenshot({ type: 'png', timeout: 15000 });
      } else {
        buffer = await page.screenshot({ type: 'png', fullPage: Boolean(step.full_page), timeout: 20000 });
      }
      ctx.result.screenshots.push({ name, buffer });
      return;
    }
    case 'upload_file': {
      const file = step.file ? String(step.file) : '';
      if (!file) throw new RecipeError('upload_missing_file', { failed_step: step.id });
      const loc = await resolveLocator(page, step, ctx, { state: 'attached' });
      const isInput = await loc.evaluate((el) => el.tagName === 'INPUT' && el.type === 'file').catch(() => false);
      if (isInput) {
        await loc.setInputFiles(file);
      } else {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 15000 }),
          humanize ? behavior.humanClick(loc, { signal }) : loc.click(),
        ]);
        await chooser.setFiles(file);
      }
      if (humanize) await behavior.humanDelay(1500, 3500, signal);
      return;
    }
    case 'check_text': {
      const list = step.texts || step.phrases || (step.text !== undefined ? [step.text] : []);
      const texts = (Array.isArray(list) ? list : [list]).filter(Boolean).map((t) => String(t).toLowerCase());
      const readScope = async () => {
        const txt = selectorsOf(step).length
          ? await page.locator(selectorsOf(step)[0]).first().innerText({ timeout: 3000 }).catch(() => '')
          : await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
        return String(txt).toLowerCase();
      };
      if (step.on_match === 'abort_blocked' || step.on_match === 'abort') {
        // Guard step: a single read; any phrase present → stop the job as blocked.
        // Include the URL so redirects like /challenge/ or /checkpoint/ are caught too.
        const lower = `${String(page.url()).toLowerCase()}\n${await readScope()}`;
        const hit = texts.find((t) => lower.includes(t));
        if (hit) {
          throw new RecipeError(`blocked_text:${hit.slice(0, 60)}`, {
            failed_step: step.id,
            warnings: step.warning ? [step.warning] : ['action_blocked'],
            blocked: step.on_match === 'abort_blocked',
          });
        }
        return;
      }
      const expect = step.expect || 'present';
      const deadline = Date.now() + num(step.timeout_ms, 8000);
      let ok = false;
      do {
        const lower = await readScope();
        const found = texts.some((t) => lower.includes(t));
        ok = expect === 'absent' ? !found : found;
        if (ok) break;
        // eslint-disable-next-line no-await-in-loop
        await behavior.sleep(700, signal);
      } while (Date.now() < deadline);
      if (!ok) {
        throw new RecipeError(`check_text_failed:${expect}`, {
          failed_step: step.id,
          warnings: step.warning ? [step.warning] : [],
        });
      }
      return;
    }
    default:
      throw new RecipeError(`unknown_action:${step.action}`, { failed_step: step.id });
  }
}

/**
 * Runs INSIDE the browser. Extracts fields relative to `root`.
 * Field spec: "css" | { selector|selectors, attr?, multiple?, regex?, html? }
 * selector ":scope" (or empty) means the root element itself.
 */
function extractFields(root, fields) {
  const out = {};
  const pick = (el, spec) => {
    if (!el) return null;
    if (spec.attr && spec.attr !== 'text' && spec.attr !== 'innerText') {
      if (spec.attr === 'href' && 'href' in el) return el.href || el.getAttribute('href');
      if (spec.attr === 'src' && 'src' in el) return el.src || el.getAttribute('src');
      return el.getAttribute(spec.attr);
    }
    if (spec.html) return el.innerHTML;
    return (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
  };
  const find = (sel, all) => {
    if (!sel || sel === ':scope') return all ? [root] : root;
    if (sel.startsWith('//') || sel.startsWith('xpath=') || sel.startsWith('./')) {
      try {
        const xp = sel.startsWith('xpath=') ? sel.slice(6) : sel;
        const doc = root.ownerDocument || root;
        const snap = doc.evaluate(xp.startsWith('//') && root !== doc.documentElement ? `.${xp}` : xp, root, null, 7, null);
        const arr = [];
        for (let k = 0; k < snap.snapshotLength; k += 1) arr.push(snap.snapshotItem(k));
        return all ? arr : arr[0] || null;
      } catch (e) {
        return all ? [] : null;
      }
    }
    try {
      return all ? Array.from(root.querySelectorAll(sel)) : root.querySelector(sel);
    } catch (e) {
      return all ? [] : null;
    }
  };
  for (const name of Object.keys(fields || {})) {
    let spec = fields[name];
    if (typeof spec === 'string') spec = { selector: spec };
    const sels = Array.isArray(spec.selectors) ? spec.selectors : [spec.selector];
    const multiple = Boolean(spec.multiple || spec.all);
    let val = null;
    for (const sel of sels) {
      if (multiple) {
        const els = find(sel, true);
        if (els.length) { val = els.map((e) => pick(e, spec)).filter((v) => v != null && v !== ''); break; }
      } else {
        const el = find(sel, false);
        const v = pick(el, spec);
        if (v != null && v !== '') { val = v; break; }
      }
    }
    if (val != null && spec.regex) {
      try {
        const re = new RegExp(spec.regex, 'i');
        const apply = (s) => { const m = re.exec(String(s)); return m ? (m[1] !== undefined ? m[1] : m[0]) : null; };
        val = Array.isArray(val) ? val.map(apply).filter(Boolean) : apply(val);
      } catch (e) { /* bad regex → raw value */ }
    }
    out[name] = val;
  }
  return out;
}

module.exports = { executeRecipe, RecipeError, buildAccessibilityTree, render, renderString, extractFields };
