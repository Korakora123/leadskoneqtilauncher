'use strict';
/**
 * search_load_board — Dispatch OS load search (DISPATCH_CONTRACTS.md §4).
 *
 * payload: { board: 'dat'|'truckstop'|'123loadboard', origin: { city?, state?, zip? },
 *            radius_mi?=100, equipment?='dry_van', pickup_date?='YYYY-MM-DD' (default today),
 *            max_results?=25 (≤ 50) }
 * result data: { board, searched_at, origin, radius_mi, equipment, pickup_date, count,
 *                loads: [{ external_ref, broker_name, broker_mc, origin, destination, pickup_at,
 *                          equipment, weight_lbs, miles, rate_cents, rate_per_mile_cents, posted_at }],
 *                _meta: { board, raw_rows, max_results, truncated, paced_ms } }
 *
 * Compliance (DISPATCH_OS §0 rule 2 + §3.3): uses the dispatcher's OWN logged-in board profile
 * (platform key = board), human pace (low daily limit in profile-manager + a randomized
 * 45-90 s gap between consecutive searches on the same profile), one results page per search,
 * at most 50 rows. Rows are returned to the brain only (tenant-scoped there) — never written
 * to disk, never logged.
 *
 * Recipe (brain, platform = board, action = search_loads) must save a list `loads` with fields
 *   external_ref, broker_name, broker_mc, origin, destination, pickup, equipment, weight, miles,
 *   rate, posted
 */
const crypto = require('crypto');
const { JobError, requireRecipe, relativeToIso, pickList, clean } = require('./_helpers');
const { BOARD_PLATFORMS } = require('../profile-manager');

const MAX_RESULTS_CAP = 50;
const DEFAULT_MAX_RESULTS = 25;

/** Minimum randomized gap between consecutive searches on the same board profile. */
const PACING = { min_ms: 45000, max_ms: 90000 };
/** profile_id → epoch ms before which the next search must not start (in memory only). */
const nextAllowedAt = new Map();

function delayScale() {
  const s = Number(process.env.KONEQTI_DELAY_SCALE || 1);
  return Number.isFinite(s) && s >= 0 ? s : 1;
}

// ---------------- equipment ----------------

/** Canonical equipment slugs → board label + DAT-style code + aliases seen on boards. */
const EQUIPMENT = {
  dry_van: { label: 'Van', code: 'V', aliases: ['van', 'dry van', 'v', 'dv', 'vans', '53 van', "53' van"] },
  reefer: { label: 'Reefer', code: 'R', aliases: ['reefer', 'r', 'refrigerated', 'rf', 'reefers'] },
  flatbed: { label: 'Flatbed', code: 'F', aliases: ['flatbed', 'f', 'fb', 'flat', 'flatbeds', 'flat bed'] },
  step_deck: { label: 'Step Deck', code: 'SD', aliases: ['step deck', 'stepdeck', 'sd', 'drop deck'] },
  power_only: { label: 'Power Only', code: 'PO', aliases: ['power only', 'po'] },
  box_truck: { label: 'Box Truck', code: 'SB', aliases: ['box truck', 'straight box truck', 'box', 'sb', 'straight truck'] },
  hotshot: { label: 'Hotshot', code: 'HS', aliases: ['hotshot', 'hot shot', 'hs'] },
  conestoga: { label: 'Conestoga', code: 'CN', aliases: ['conestoga', 'cn'] },
  tanker: { label: 'Tanker', code: 'T', aliases: ['tanker', 't', 'tank'] },
  lowboy: { label: 'Lowboy', code: 'LB', aliases: ['lowboy', 'lb'] },
  double_drop: { label: 'Double Drop', code: 'DD', aliases: ['double drop', 'dd'] },
  container: { label: 'Container', code: 'C', aliases: ['container', 'c', 'containers'] },
  auto_carrier: { label: 'Auto Carrier', code: 'AC', aliases: ['auto carrier', 'car hauler', 'ac'] },
};

function normKey(v) {
  return String(v || '').toLowerCase().replace(/[_\-/]+/g, ' ').replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
}

/** "V" / "Van" / "dry_van" / "Reefer, Van" → canonical slug (first match), else slugified text. */
function normalizeEquipment(v) {
  const raw = clean(v, 120);
  if (!raw) return null;
  const whole = normKey(raw);
  for (const [slug, e] of Object.entries(EQUIPMENT)) {
    if (whole === slug.replace(/_/g, ' ') || e.aliases.includes(whole) || normKey(e.label) === whole) return slug;
  }
  // Multi-value cells ("Van, Reefer" / "V R"): first recognizable part.
  for (const part of raw.split(/[,;|/]+|\s+or\s+/i)) {
    const k = normKey(part);
    for (const [slug, e] of Object.entries(EQUIPMENT)) {
      if (k && (k === slug.replace(/_/g, ' ') || e.aliases.includes(k) || normKey(e.label) === k)) return slug;
    }
  }
  for (const [slug, e] of Object.entries(EQUIPMENT)) {
    if (e.aliases.filter((a) => a.length > 3).some((a) => whole.includes(a))) return slug;
  }
  return whole.replace(/\s+/g, '_').slice(0, 60) || null;
}

// ---------------- parsers ----------------

/** "$2,450" → 245000 · "$2,450.50" → 245050 · "2.4k" → 240000 · "—" → null. Per-mile values → null. */
function parseMoneyCents(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s || isPerMile(s)) return null;
  const m = /(\d[\d,]*)(?:\.(\d{1,2}))?\s*(k)?/i.exec(s);
  if (!m) return null;
  let dollars = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(dollars)) return null;
  let cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  if (m[3]) {
    const f = parseFloat(`${m[1].replace(/,/g, '')}.${m[2] || 0}`) * 1000;
    dollars = Math.floor(f);
    cents = Math.round((f - dollars) * 100);
  }
  const total = dollars * 100 + cents;
  return total > 0 ? total : null;
}

function isPerMile(s) {
  return /\/\s*mi\b|per\s*mi|\brpm\b|\/\s*mile/i.test(String(s || ''));
}

/** "$2.15/mi" → 215 (cents per mile); total rates → null. */
function parsePerMileCents(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!isPerMile(s)) return null;
  const m = /(\d+)(?:\.(\d{1,2}))?/.exec(s);
  if (!m) return null;
  const c = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  return c > 0 ? c : null;
}

/** US-style number: "1,234" → 1234 · "42.5k" → 42500 (never treats "mi" / "m" as millions). */
function parseUsNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * 1000 : n;
}

/** "1,234 mi" → 1234 · "781" → 781 · "—" → null */
function parseMiles(v) {
  const n = parseUsNumber(v);
  return n && n > 0 ? Math.round(n) : null;
}

/** "42,000 lbs" → 42000 · "42K lbs" → 42000 · "21 tons" → 42000 */
function parseWeightLbs(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const n = parseUsNumber(s);
  if (!n || n <= 0) return null;
  if (/\btons?\b|\d\s*t\b/i.test(s) && n < 100) return Math.round(n * 2000);
  return Math.round(n);
}

/** "MC# 123456" / "MC-0987654" / "123456" → digits string; otherwise null. */
function parseMc(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = /\bMC\s*(?:#|no\.?|number)?\s*[:\-]?\s*(\d{4,8})\b/i.exec(s);
  if (m) return m[1];
  const t = s.trim();
  if (/^\d{4,8}$/.test(t)) return t;
  return null;
}

/** Strip an embedded "MC# 123456" (and phone / credit noise) from a broker cell. */
function cleanBrokerName(v) {
  const s = clean(v, 300);
  if (!s) return null;
  const out = s
    .replace(/\bMC\s*(?:#|no\.?|number)?\s*[:\-]?\s*\d{4,8}\b/ig, ' ')
    .replace(/\bDOT\s*#?\s*[:\-]?\s*\d{4,9}\b/ig, ' ')
    .replace(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, ' ')
    .replace(/[|·•]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out || null;
}

const STATE_RE = /^[A-Z]{2}$/;

/** "Dallas, TX" · "Dallas, TX 75201" · "Dallas TX (32)" · "75201" → { city, state, zip } */
function parseLocation(v) {
  let s = clean(v, 200);
  if (!s) return null;
  s = s.replace(/\(\s*\d+\s*(?:mi)?\s*\)/gi, ' ').replace(/\s+/g, ' ').trim(); // deadhead "(32)"
  let zip = null;
  const z = /\b(\d{5})(?:-\d{4})?\b/.exec(s);
  if (z) { zip = z[1]; s = s.replace(z[0], ' ').replace(/\s+/g, ' ').trim(); }
  s = s.replace(/[,\s]+$/, '');
  let city = null;
  let state = null;
  const m = /^(.*?)[,\s]+([A-Za-z]{2})$/.exec(s);
  if (m && STATE_RE.test(m[2].toUpperCase()) && m[1].trim()) {
    city = m[1].replace(/,$/, '').trim();
    state = m[2].toUpperCase();
  } else if (STATE_RE.test(s.toUpperCase()) && s.length === 2) {
    state = s.toUpperCase();
  } else if (s) {
    city = s;
  }
  if (!city && !state && !zip) return null;
  return { city: city || null, state, zip };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function localYmd(date) {
  return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Pick the year that puts month/day closest to the reference date (boards omit the year). */
function inferYear(month, day, ref) {
  const y = ref.getFullYear();
  let best = y;
  let bestDiff = Infinity;
  for (const cand of [y - 1, y, y + 1]) {
    const diff = Math.abs(new Date(cand, month - 1, day).getTime() - ref.getTime());
    if (diff < bestDiff) { bestDiff = diff; best = cand; }
  }
  return best;
}

function validMd(m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/**
 * Pickup cell → ISO date "YYYY-MM-DD" (the first day of a window like "10/06 - 10/07").
 * Full ISO timestamps with a zone are kept as full ISO.
 */
function parsePickup(v, ref = new Date()) {
  const s = clean(v, 120);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m && validMd(Number(m[2]), Number(m[3]))) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (!validMd(mo, d)) return null;
    let y = m[3] ? Number(m[3]) : inferYear(mo, d, ref);
    if (y < 100) y += 2000;
    return ymd(y, mo, d);
  }
  m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    const d = Number(m[2]);
    if (!validMd(mo, d)) return null;
    return ymd(m[3] ? Number(m[3]) : inferYear(mo, d, ref), mo, d);
  }
  if (/\btoday\b/i.test(s)) return localYmd(ref);
  if (/\btomorrow\b/i.test(s)) return localYmd(new Date(ref.getTime() + 86400e3));
  return null;
}

/**
 * Posted / age cell → ISO timestamp. "5m" · "2h" · "1d" · "12 min ago" · "00:45" (DAT-style
 * age hh:mm) · "10/04 08:15" (board local time) · full ISO.
 */
function parsePosted(v, now = Date.now()) {
  const s = clean(v, 120);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  let m = /^(\d+)\s*(s|m|min|h|hr|d)\b\.?$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 's' ? 1e3 : unit.startsWith('m') ? 60e3 : unit.startsWith('h') ? 3600e3 : 86400e3;
    return new Date(now - n * ms).toISOString();
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return new Date(now - (Number(m[1]) * 60 + Number(m[2])) * 60e3).toISOString();
  if (/just now/i.test(s)) return new Date(now).toISOString();
  m = /(\d+)\s*(sec|second|min|minute|hr|hour|day|week)s?\b.*ago/i.exec(s);
  if (m) {
    const unit = { sec: 1e3, second: 1e3, min: 60e3, minute: 60e3, hr: 3600e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3 }[m[2].toLowerCase()];
    return new Date(now - Number(m[1]) * unit).toISOString();
  }
  if (/ago/i.test(s)) return relativeToIso(s, now);
  m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2})\s*(am|pm)?)?/i.exec(s);
  if (m && validMd(Number(m[1]), Number(m[2]))) {
    const ref = new Date(now);
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let y = m[3] ? Number(m[3]) : inferYear(mo, d, ref);
    if (y < 100) y += 2000;
    let h = m[4] ? Number(m[4]) : 0;
    if (m[6] && /pm/i.test(m[6]) && h < 12) h += 12;
    if (m[6] && /am/i.test(m[6]) && h === 12) h = 0;
    return new Date(y, mo - 1, d, h, m[5] ? Number(m[5]) : 0).toISOString();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && /\d{4}/.test(s) ? new Date(t).toISOString() : null;
}

// ---------------- payload → recipe vars ----------------

function parsePickupDate(v) {
  if (!v) return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new JobError('invalid_pickup_date', { status: 'failed' });
  return new Date(t);
}

function normalizeOrigin(o) {
  const src = typeof o === 'string' ? parseLocation(o) || {} : o || {};
  const city = clean(src.city, 100);
  const state = clean(src.state, 2) ? String(src.state).trim().toUpperCase().slice(0, 2) : null;
  const zip = clean(src.zip, 10) ? String(src.zip).trim().slice(0, 10) : null;
  if (!(city && state) && !zip) throw new JobError('missing_payload_fields:origin', { status: 'failed' });
  return { city: city || null, state, zip };
}

function buildVars(payload, board) {
  const origin = normalizeOrigin(payload.origin);
  const radius = Math.max(10, Math.min(500, Math.round(Number(payload.radius_mi) || 100)));
  const equipment = normalizeEquipment(payload.equipment || 'dry_van') || 'dry_van';
  const eq = EQUIPMENT[equipment] || { label: clean(payload.equipment, 60) || 'Van', code: '' };
  const max = Math.max(1, Math.min(MAX_RESULTS_CAP, Math.round(Number(payload.max_results) || DEFAULT_MAX_RESULTS)));
  const pd = parsePickupDate(payload.pickup_date);
  const originText = origin.city && origin.state ? `${origin.city}, ${origin.state}` : origin.zip;
  const query = { origin: originText, radius, equipment: eq.code || eq.label, date: localYmd(pd) };
  return {
    board,
    origin,
    origin_city: origin.city || '',
    origin_state: origin.state || '',
    origin_zip: origin.zip || '',
    origin_text: originText,
    origin_query: originText,
    origin_encoded: encodeURIComponent(originText),
    radius_mi: radius,
    radius,
    equipment,
    equipment_label: eq.label,
    equipment_code: eq.code || eq.label,
    pickup_date: localYmd(pd),
    pickup_date_us: `${pad(pd.getMonth() + 1)}/${pad(pd.getDate())}/${pd.getFullYear()}`,
    pickup_date_short: `${pad(pd.getMonth() + 1)}/${pad(pd.getDate())}`,
    max_results: max,
    limit: max,
    // rows the recipe may read: a little above max_results so dedupe / ad rows don't starve the page
    extract_limit: Math.min(MAX_RESULTS_CAP + 10, max + 10),
    query_encoded: new URLSearchParams(query).toString(),
    _pickup_ref: pd,
  };
}

// ---------------- rows → contract loads ----------------

function rowRef(board, load) {
  const basis = [board, load.origin && JSON.stringify(load.origin), load.destination && JSON.stringify(load.destination),
    load.pickup_at, load.broker_name, load.rate_cents, load.equipment].join('|');
  return `h_${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

function normalizeRow(r, board, ref, now) {
  const brokerRaw = r.broker_name ?? r.broker ?? r.company;
  const rateRaw = r.rate ?? r.rate_text;
  const load = {
    external_ref: clean(r.external_ref ?? r.ref ?? r.id, 120),
    broker_name: cleanBrokerName(brokerRaw),
    broker_mc: parseMc(r.broker_mc) || parseMc(brokerRaw),
    origin: parseLocation(r.origin),
    destination: parseLocation(r.destination),
    pickup_at: parsePickup(r.pickup ?? r.pickup_at ?? r.pickup_date, ref),
    equipment: normalizeEquipment(r.equipment),
    weight_lbs: parseWeightLbs(r.weight ?? r.weight_lbs),
    miles: parseMiles(r.miles ?? r.trip),
    rate_cents: parseMoneyCents(rateRaw),
    rate_per_mile_cents: parsePerMileCents(rateRaw ?? r.rate_per_mile),
    posted_at: parsePosted(r.posted ?? r.age ?? r.posted_at, now),
  };
  if (load.rate_per_mile_cents === null && r.rate_per_mile) load.rate_per_mile_cents = parsePerMileCents(`${r.rate_per_mile}/mi`);
  if (!load.origin && !load.destination) return null; // header / ad / empty row
  if (!load.external_ref) load.external_ref = rowRef(board, load);
  return load;
}

async function pace(profileId, signal, progress) {
  const until = nextAllowedAt.get(profileId) || 0;
  const wait = Math.max(0, until - Date.now());
  if (wait > 0) {
    if (progress) progress('pacing', `waiting ${Math.round(wait / 1000)}s between board searches`);
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      const t = setTimeout(resolve, wait);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
      return undefined;
    });
  }
  return wait;
}

function scheduleNext(profileId) {
  const gap = (PACING.min_ms + Math.random() * (PACING.max_ms - PACING.min_ms)) * delayScale();
  nextAllowedAt.set(profileId, Date.now() + gap);
  return gap;
}

module.exports = {
  // exported for tests
  EQUIPMENT,
  PACING,
  normalizeEquipment,
  parseMoneyCents,
  parsePerMileCents,
  parseMiles,
  parseWeightLbs,
  parseMc,
  cleanBrokerName,
  parseLocation,
  parsePickup,
  parsePosted,
  buildVars,
  normalizeRow,
  _resetPacing: () => nextAllowedAt.clear(),

  type: 'search_load_board',
  platform: (job) => String(((job && job.payload) || {}).board || (job && job.platform) || '').trim().toLowerCase(),
  category: 'actions', // one search = one action toward the board's low daily limit
  async run(ctx) {
    const { job, payload } = ctx;
    const board = String(payload.board || '').trim().toLowerCase();
    if (!board) throw new JobError('missing_payload_fields:board', { status: 'failed' });
    if (!BOARD_PLATFORMS.includes(board)) throw new JobError(`unsupported_board:${board.slice(0, 40)}`, { status: 'failed' });
    // Must run on the dispatcher's own logged-in profile for THIS board.
    if (!ctx.profile || ctx.profile.platform !== board) {
      throw new JobError(`no_profile_for_platform:${board}`, { status: 'failed' });
    }
    requireRecipe(job);
    const vars = buildVars(payload, board);
    const ref = vars._pickup_ref;
    delete vars._pickup_ref;

    const pacedMs = await pace(ctx.profile.id, ctx.signal, ctx.progress);
    let res;
    try {
      res = await ctx.runRecipe(vars);
    } finally {
      scheduleNext(ctx.profile.id); // the board saw a request either way
    }

    const raw = pickList(res.data, ['loads', 'results', 'rows', 'extract']);
    const now = Date.now();
    const seen = new Set();
    const loads = [];
    let truncated = false;
    for (let i = 0; i < raw.length; i += 1) {
      const r = raw[i];
      if (!r || typeof r !== 'object') continue;
      const load = normalizeRow(r, board, ref, now);
      if (!load || seen.has(load.external_ref)) continue;
      seen.add(load.external_ref);
      if (loads.length >= vars.max_results) { truncated = true; break; }
      loads.push(load);
    }
    if (raw.length >= vars.extract_limit) truncated = true;
    return {
      data: {
        board,
        searched_at: new Date(now).toISOString(),
        origin: vars.origin,
        radius_mi: vars.radius_mi,
        equipment: vars.equipment,
        pickup_date: vars.pickup_date,
        count: loads.length,
        loads,
        _meta: {
          board,
          raw_rows: raw.length,
          max_results: vars.max_results,
          truncated,
          paced_ms: Math.round(pacedMs),
        },
      },
      countAction: true,
    };
  },
};
