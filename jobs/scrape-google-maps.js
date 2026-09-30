'use strict';
/**
 * scrape_google_maps — one search per sub-area (discovery tiling, Agent 01).
 * payload: { query, location?, max_results?=20, area_id?, niche?, lat?, lng? }
 * recipe vars added: search, search_url
 * recipe must save a list `results` with fields
 *   name, rating, reviews_count, category, address, phone, website, maps_url
 */
const { requireRecipe, requireFields, parseCount, parseRating, pickList, clean } = require('./_helpers');

const PHONE_RE = /\+?\(?\d[\d\s().-]{6,}\d/; // leading "(" kept: (512) 555-0142
const HOURS_RE = /open|closed|closes|opens|24 hours|abierto|cerrado|مفتوح|مغلق/i;

/** Seeded recipe returns `info` rows (e.g. ["4.6(120) · Plumber · 12 Main St", "Open ⋅ Closes 6PM · (214) 555-0100"]). */
function parseInfo(info) {
  const out = { category: null, address: null, phone: null };
  const rows = Array.isArray(info) ? info : info ? [info] : [];
  const parts = rows.join(' · ').split(/[·⋅]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const part of parts) {
    if (/^\d(?:[.,]\d)?\s*\(/.test(part) || /^\(?[\d,.]+\)?$/.test(part)) continue; // rating / count
    if (HOURS_RE.test(part)) continue;
    if (!out.phone && PHONE_RE.test(part) && part.replace(/\D/g, '').length >= 7 && !/[a-z]{3,}/i.test(part)) {
      out.phone = part.match(PHONE_RE)[0].trim();
      continue;
    }
    if (!out.category && !/\d/.test(part)) { out.category = part.slice(0, 200); continue; }
    if (!out.address && /\d/.test(part) && /[a-z\u0600-\u06FF]/i.test(part)) out.address = part.slice(0, 500);
  }
  return out;
}

module.exports = {
  parseInfo,
  type: 'scrape_google_maps',
  platform: 'web',
  category: 'none',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    requireFields(payload, ['query']);
    const max = Math.max(1, Math.min(120, Number(payload.max_results) || 20));
    const search = [payload.query, payload.location].filter(Boolean).join(' ');
    let searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(search)}`;
    if (Number.isFinite(Number(payload.lat)) && Number.isFinite(Number(payload.lng))) {
      searchUrl += `/@${Number(payload.lat)},${Number(payload.lng)},${Number(payload.zoom) || 13}z`;
    }
    const res = await ctx.runRecipe({
      search,
      search_url: searchUrl,
      query: search, // seeded recipe: https://www.google.com/maps/search/{{query}}
      query_encoded: encodeURIComponent(search),
      max_results: max,
      limit: max,
      max_scrolls: Math.min(40, Math.ceil(max / 4) + 1),
    });
    const raw = pickList(res.data, ['results', 'places', 'items', 'extract']);
    const seen = new Set();
    const results = [];
    for (const r of raw) {
      const name = clean(r.name, 300);
      if (!name) continue;
      const key = (r.maps_url || name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const website = clean(r.website, 500);
      const info = parseInfo(r.info);
      results.push({
        name,
        rating: parseRating(r.rating),
        reviews_count: parseCount(r.reviews_count ?? r.review_count),
        category: clean(r.category, 200) || info.category,
        address: clean(r.address, 500) || info.address,
        phone: clean(r.phone, 60) || info.phone,
        website,
        maps_url: clean(r.maps_url, 1000),
        no_website: !website,
      });
      if (results.length >= max) break;
    }
    return {
      data: {
        query: payload.query,
        location: payload.location || null,
        area_id: payload.area_id ?? null,
        niche: payload.niche || null,
        count: results.length,
        results,
      },
    };
  },
};
