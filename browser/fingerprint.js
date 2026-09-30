'use strict';
/**
 * Deterministic fingerprint parameters derived from a profile's fingerprint_seed.
 * Same seed → same viewport / screen / hardware hints on every launch.
 *
 * Locale + timezone deliberately follow the SYSTEM (the profile browses from the
 * user's own residential IP, so the timezone must match that IP). A profile with
 * its own proxy may set profile.timezone / profile.locale explicitly.
 */
const crypto = require('crypto');

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
];

function seededRandom(seed) {
  // mulberry32 on a 32-bit hash of the seed
  let a = crypto.createHash('sha256').update(String(seed || 'default')).digest().readUInt32LE(0);
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch (_) {
    return 'en-US';
  }
}

function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

/** @returns {{viewport:{width:number,height:number}, screen:{width:number,height:number}, deviceScaleFactor:number, hardwareConcurrency:number, locale:string, timezoneId:string, numericSeed:number}} */
function fingerprintFor(profile = {}) {
  const rnd = seededRandom(profile.fingerprint_seed);
  const vp = VIEWPORTS[Math.floor(rnd() * VIEWPORTS.length)];
  // Browser chrome eats some vertical space; window slightly smaller than screen.
  const viewport = { width: vp.width - Math.floor(rnd() * 3) * 16, height: vp.height - 80 - Math.floor(rnd() * 4) * 10 };
  const deviceScaleFactor = vp.width >= 1920 ? 1 : [1, 1, 1.25][Math.floor(rnd() * 3)];
  const hardwareConcurrency = [4, 8, 8, 12, 16][Math.floor(rnd() * 5)];
  return {
    viewport,
    screen: { width: vp.width, height: vp.height },
    deviceScaleFactor,
    hardwareConcurrency,
    locale: profile.locale || systemLocale(),
    timezoneId: profile.timezone || systemTimezone(),
    numericSeed: Math.floor(rnd() * 2 ** 31),
  };
}

/** Parse a proxy string ("http://user:pass@host:port") into a Playwright proxy object. */
function parseProxy(proxy) {
  if (!proxy) return undefined;
  if (typeof proxy === 'object' && proxy.server) return proxy;
  try {
    const u = new URL(String(proxy));
    const out = { server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}` };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch (_) {
    return { server: String(proxy) };
  }
}

module.exports = { fingerprintFor, seededRandom, parseProxy, systemLocale, systemTimezone };
