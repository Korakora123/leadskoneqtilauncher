'use strict';
/**
 * check_gbp — current state of a Google Business Profile (Agent 16 snapshots).
 * payload: { maps_url | gbp_url, prospect_id?, max_reviews?=10 }
 * recipe vars added: url
 * recipe saves object `place` (or `extract_profile`) { name, rating, reviews_count|review_count, category,
 *          address, phone, website, hours, last_post_date, booking_url|booking_link }
 *          and list `reviews` (or `extract_reviews`) { author, text, stars, date, owner_response|owner_reply }
 * recipe vars added: url, gbp_url, maps_url, max_reviews
 */
const { requireRecipe, JobError, parseCount, parseRating, relativeToIso, pickList, pickObj, clean } = require('./_helpers');

module.exports = {
  type: 'check_gbp',
  platform: 'web',
  category: 'none',
  async run(ctx) {
    const { job, payload } = ctx;
    requireRecipe(job);
    const url = payload.maps_url || payload.gbp_url || payload.url;
    if (!url) throw new JobError('missing_payload_fields:maps_url');
    const maxReviews = Math.max(1, Math.min(50, Number(payload.max_reviews) || 10));
    const res = await ctx.runRecipe({ url, gbp_url: url, maps_url: url, max_reviews: maxReviews });
    const place = pickObj(res.data, ['place', 'gbp', 'profile', 'extract_profile']);
    const reviews = pickList(res.data, ['reviews', 'extract_reviews']).slice(0, maxReviews).map((r) => {
      const reply = r.owner_response ?? r.owner_reply;
      return {
        author: clean(r.author, 200),
        text: clean(r.text, 3000),
        stars: parseRating(r.stars),
        date_text: clean(r.date, 80),
        date: relativeToIso(r.date),
        has_owner_response: Boolean(clean(reply, 10)),
        owner_response: clean(reply, 1500),
      };
    });
    const responded = reviews.filter((r) => r.has_owner_response).length;
    const bookingUrl = clean(place.booking_url ?? place.booking_link, 1000);
    const strip = (v, max) => {
      const t = clean(v, max);
      return t ? t.replace(/^(address|phone|website|hours)\s*:\s*/i, '') : null;
    };
    return {
      data: {
        prospect_id: payload.prospect_id || null,
        url,
        name: clean(place.name, 300),
        rating: parseRating(place.rating),
        reviews_count: parseCount(place.reviews_count ?? place.review_count),
        category: clean(place.category, 200),
        address: strip(place.address, 500),
        website: clean(place.website, 500),
        phone: strip(place.phone, 60),
        hours_text: clean(place.hours, 500),
        last_post_date_text: clean(place.last_post_date, 80),
        last_post_at: relativeToIso(place.last_post_date),
        has_booking_link: Boolean(bookingUrl),
        booking_url: bookingUrl,
        owner_response_rate: reviews.length ? Math.round((responded / reviews.length) * 100) / 100 : null,
        reviews,
        checked_at: new Date().toISOString(),
      },
    };
  },
};
