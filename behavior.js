'use strict';
/**
 * Behavior engine — every action goes through human-like wrappers.
 * "If a human couldn't do it, the bot doesn't do it."
 *
 * Pure Playwright + Node; no Electron imports (reusable by a cloud executor).
 */

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** Gaussian-ish random between min and max (sum of uniforms). */
function randNormal(min, max) {
  const r = (Math.random() + Math.random() + Math.random()) / 3;
  return min + r * (max - min);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(t);
      reject(new Error('cancelled'));
    }
    if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
    return undefined;
  });
}

/** Random human wait in ms (min..max). */
async function humanDelay(min = 400, max = 1600, signal) {
  const scale = Number(process.env.KONEQTI_DELAY_SCALE || 1);
  await sleep(randNormal(min, max) * (Number.isFinite(scale) ? scale : 1), signal);
}

/** Seconds a person needs to read `text` (~230 wpm), clamped. Returns ms. */
function readingTime(text, { min = 800, max = 20000 } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const ms = (words / 230) * 60000 * rand(0.8, 1.25);
  return Math.round(Math.min(max, Math.max(min, ms)));
}

function isLocator(x) {
  return x && typeof x === 'object' && typeof x.click === 'function' && typeof x.page === 'function';
}

/** Move the mouse along a slightly curved path to (x,y) or to a locator's center. */
async function humanMove(page, target) {
  try {
    let x;
    let y;
    if (isLocator(target)) {
      const box = await target.boundingBox();
      if (!box) return;
      x = box.x + box.width * rand(0.3, 0.7);
      y = box.y + box.height * rand(0.3, 0.7);
    } else if (target && typeof target.x === 'number') {
      ({ x, y } = target);
    } else {
      const vp = page.viewportSize() || { width: 1280, height: 800 };
      x = rand(vp.width * 0.2, vp.width * 0.8);
      y = rand(vp.height * 0.2, vp.height * 0.8);
    }
    await page.mouse.move(x, y, { steps: Math.round(rand(8, 25)) });
  } catch (_) {
    /* mouse moves are best-effort */
  }
}

/** Human click: move to element, short hover, click. */
async function humanClick(locator, opts = {}) {
  const page = locator.page();
  await locator.scrollIntoViewIfNeeded({ timeout: opts.timeout || 10000 }).catch(() => {});
  await humanMove(page, locator);
  await humanDelay(120, 450, opts.signal);
  await locator.click({ timeout: opts.timeout || 10000, delay: Math.round(rand(40, 140)) });
}

/**
 * Per-character typing with variance and occasional thinking pauses.
 * @param {import('playwright-core').Page|import('playwright-core').Locator} target
 */
async function humanType(target, text, opts = {}) {
  const str = String(text == null ? '' : text);
  let page = target;
  if (isLocator(target)) {
    page = target.page();
    await humanClick(target, opts);
    await humanDelay(200, 700, opts.signal);
  }
  const kb = page.keyboard;
  for (let i = 0; i < str.length; i += 1) {
    if (opts.signal && opts.signal.aborted) throw new Error('cancelled');
    const ch = str[i];
    if (ch === '\n') {
      // Shift+Enter keeps multi-line messages from sending early in chat UIs.
      await kb.press(opts.newlineKey || 'Shift+Enter');
    } else {
      await kb.type(ch);
    }
    let d = randNormal(35, 160);
    if (ch === ' ' && Math.random() < 0.08) d += rand(250, 900); // word-level pause
    if (/[.,!?؟،]/.test(ch) && Math.random() < 0.4) d += rand(200, 700);
    if (Math.random() < 0.015) d += rand(600, 1800); // thinking pause
    await sleep(d * Number(process.env.KONEQTI_DELAY_SCALE || 1), opts.signal);
  }
}

/** Read-like scrolling: several wheel steps with pauses; optionally inside a container. */
async function humanScroll(page, opts = {}) {
  const { times = Math.round(rand(2, 5)), container = null, direction = 'down', signal } = opts;
  for (let i = 0; i < times; i += 1) {
    if (signal && signal.aborted) throw new Error('cancelled');
    const dy = Math.round(rand(250, 700)) * (direction === 'up' ? -1 : 1);
    if (container) {
      const loc = typeof container === 'string' ? page.locator(container).first() : container;
      await humanMove(page, loc);
      await loc.evaluate((el, d) => el.scrollBy({ top: d, behavior: 'smooth' }), dy).catch(() => {});
    } else {
      await page.mouse.wheel(0, dy).catch(() => {});
    }
    await humanDelay(600, 2200, signal);
    if (Math.random() < 0.15) {
      // Occasionally scroll back up a little, like re-reading.
      await page.mouse.wheel(0, -Math.round(rand(80, 200))).catch(() => {});
      await humanDelay(300, 900, signal);
    }
  }
}

/**
 * Working-hours check for a profile. Delegates to ProfileManager when given,
 * otherwise evaluates profile.working_hours in-place.
 */
function sessionWindow(profile, profileManager, now = new Date()) {
  if (profileManager && typeof profileManager.sessionWindow === 'function') {
    return profileManager.sessionWindow(profile, now);
  }
  // eslint-disable-next-line global-require
  const { ProfileManager } = require('./profile-manager');
  return ProfileManager.prototype.sessionWindow.call({}, profile, now);
}

module.exports = {
  rand,
  sleep,
  humanDelay,
  humanType,
  humanClick,
  humanScroll,
  humanMove,
  readingTime,
  sessionWindow,
};
