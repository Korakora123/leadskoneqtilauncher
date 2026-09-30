'use strict';
/**
 * Shared helpers for job modules: number parsing, keyword flags, recipe guard.
 * Pure Node — no Electron imports.
 */

class JobError extends Error {
  constructor(message, { status = 'failed', warnings = [], failed_step = null } = {}) {
    super(message);
    this.name = 'JobError';
    this.status = status;
    this.warnings = warnings;
    this.failed_step = failed_step;
  }
}

/** "12.3K" → 12300, "1,204" → 1204, "2.1M" → 2100000, "١٢٣" → 123. */
function parseCount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  let s = String(v).trim();
  if (!s) return null;
  // Arabic-Indic + Eastern Arabic-Indic digits → ASCII
  s = s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  const m = /(\d[\d.,\s]*)\s*(k|m|b|mil|mill|millones|mn|lakh|ألف|مليون)?/i.exec(s);
  if (!m) return null;
  let num = m[1].replace(/\s/g, '');
  const unit = (m[2] || '').toLowerCase();
  if (unit) {
    num = num.replace(',', '.');
    const f = parseFloat(num);
    if (!Number.isFinite(f)) return null;
    const mult = { k: 1e3, 'ألف': 1e3, mil: 1e3, m: 1e6, mn: 1e6, mill: 1e6, millones: 1e6, 'مليون': 1e6, b: 1e9, lakh: 1e5 }[unit] || 1;
    return Math.round(f * mult);
  }
  num = num.replace(/[.,](?=\d{3}(\D|$))/g, '');
  const n = parseFloat(num.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** "4.3" / "4,3" / "Rated 4.3 out of 5" → 4.3 */
function parseRating(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const m = /(\d(?:[.,]\d)?)/.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
}

function toIsoDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** "3 weeks ago" / "hace 2 días" / "منذ 3 أيام" → approximate ISO timestamp (UTC). */
function relativeToIso(v, now = Date.now()) {
  if (!v) return null;
  const direct = toIsoDate(v);
  if (direct && !/ago|hace|منذ|پہلے/i.test(String(v))) return direct;
  const s = String(v).toLowerCase();
  const n = parseCount(s) || 1;
  const table = [
    [/min|minuto|دقيق|منٹ/, 60e3],
    [/hour|hr|hora|ساع|گھنٹ/, 3600e3],
    [/day|día|dia|يوم|أيام|ایام|دن/, 86400e3],
    [/week|semana|أسبوع|اسابيع|أسابيع|ہفت/, 7 * 86400e3],
    [/month|mes|شهر|أشهر|مہین/, 30 * 86400e3],
    [/year|año|ano|سنة|سنوات|سال/, 365 * 86400e3],
  ];
  for (const [re, ms] of table) {
    if (re.test(s)) return new Date(now - n * ms).toISOString();
  }
  return null;
}

const DM_TO_ORDER = [
  'dm to order', 'dm for order', 'dm for price', 'dm for prices', 'dm us to order', 'order via dm', 'inbox to order',
  'dm para pedidos', 'pedidos por dm', 'escríbenos por dm', 'pedidos al dm',
  'للطلب خاص', 'للطلب راسلونا', 'للطلب عالخاص', 'للطلب', 'اطلب عبر الخاص',
  'آرڈر کے لیے ڈی ایم', 'order ke liye dm', 'inbox for order',
];
const PRICE_QUESTIONS = [
  'price?', 'price pls', 'price please', 'how much', 'pm price', 'dm price', 'what\'s the price', 'cost?',
  'precio?', 'precio', 'cuánto cuesta', 'cuanto cuesta', 'cuánto vale',
  'السعر', 'بكم', 'كم السعر', 'كم سعر', 'قیمت', 'کتنے کا', 'کتنے کی', 'kitne ka', 'kitne ki', 'price kya',
];

function containsAny(text, list) {
  const t = String(text || '').toLowerCase();
  return list.filter((p) => t.includes(p.toLowerCase()));
}

function findWhatsappLinks(text) {
  const out = new Set();
  const re = /(https?:\/\/)?(wa\.me\/\+?\d+|api\.whatsapp\.com\/send\?phone=\+?\d+|chat\.whatsapp\.com\/[A-Za-z0-9]+|wa\.link\/[A-Za-z0-9]+)/gi;
  let m;
  const s = String(text || '');
  while ((m = re.exec(s))) out.add(m[0].startsWith('http') ? m[0] : `https://${m[0]}`);
  return [...out];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function findEmails(text) {
  const out = new Set();
  for (const e of String(text || '').match(EMAIL_RE) || []) {
    const low = e.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(low)) continue;
    if (/example\.com|sentry\.|wixpress\.com|@2x/.test(low)) continue;
    out.add(low);
  }
  return [...out];
}

/** Guard: platform jobs execute brain recipes; there is no local selector logic. */
function requireRecipe(job) {
  if (!job.recipe || !Array.isArray(job.recipe.steps) || !job.recipe.steps.length) {
    throw new JobError('recipe_required', { status: 'failed' });
  }
}

function requireFields(payload, fields) {
  const missing = fields.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
  if (missing.length) throw new JobError(`missing_payload_fields:${missing.join(',')}`, { status: 'failed' });
}

/** First array found among the given keys of recipe data. */
function pickList(data, keys) {
  for (const k of keys) if (Array.isArray(data && data[k])) return data[k];
  return [];
}

function pickObj(data, keys) {
  for (const k of keys) if (data && data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])) return data[k];
  return {};
}

function clean(s, max = 5000) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

module.exports = {
  JobError,
  parseCount,
  parseRating,
  toIsoDate,
  relativeToIso,
  DM_TO_ORDER,
  PRICE_QUESTIONS,
  containsAny,
  findWhatsappLinks,
  findEmails,
  requireRecipe,
  requireFields,
  pickList,
  pickObj,
  clean,
};
