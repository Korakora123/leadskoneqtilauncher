'use strict';
/**
 * scrape_website — page text + meta + detected tech + contact emails.
 * Generic (no platform selectors). Used by Agent 02 enrichment, segment classifier,
 * POS / booking / CRM detection, tool_sprawl signal.
 *
 * payload: { url, max_pages?=3, include_text?=true, tech_signatures?: { [name]: { category, patterns: string[] } } }
 * recipe: optional (runs after the home page loads, e.g. to dismiss a consent banner).
 */
const { JobError, findEmails, findWhatsappLinks, clean } = require('./_helpers');

// Lightweight tech fingerprints (script src / html hints). Brain may override via payload.tech_signatures.
const DEFAULT_TECH = {
  calendly: { category: 'booking', patterns: ['calendly.com'] },
  acuity: { category: 'booking', patterns: ['acuityscheduling.com'] },
  setmore: { category: 'booking', patterns: ['setmore.com'] },
  square_appointments: { category: 'booking', patterns: ['squareup.com/appointments', 'square.site/book'] },
  booksy: { category: 'booking', patterns: ['booksy.com'] },
  fresha: { category: 'booking', patterns: ['fresha.com'] },
  vagaro: { category: 'booking', patterns: ['vagaro.com'] },
  mindbody: { category: 'booking', patterns: ['mindbodyonline.com', 'healcode.com'] },
  opentable: { category: 'booking', patterns: ['opentable.com'] },
  resy: { category: 'booking', patterns: ['resy.com'] },
  simplybook: { category: 'booking', patterns: ['simplybook.me', 'simplybook.it'] },
  square: { category: 'pos', patterns: ['squareup.com', 'square.site', 'squarecdn.com'] },
  toast: { category: 'pos', patterns: ['toasttab.com'] },
  clover: { category: 'pos', patterns: ['clover.com'] },
  lightspeed: { category: 'pos', patterns: ['lightspeedhq.com', 'lightspeedapp.com'] },
  shopify: { category: 'ecommerce', patterns: ['cdn.shopify.com', 'myshopify.com'] },
  woocommerce: { category: 'ecommerce', patterns: ['woocommerce'] },
  wix: { category: 'site_builder', patterns: ['wixstatic.com', 'wix.com'] },
  squarespace: { category: 'site_builder', patterns: ['squarespace.com', 'sqspcdn.com'] },
  wordpress: { category: 'site_builder', patterns: ['wp-content', 'wp-includes'] },
  foodics: { category: 'pos', patterns: ['foodics.com'] },
  loyverse: { category: 'pos', patterns: ['loyverse.com'] },
  odoo: { category: 'erp', patterns: ['odoo.com', '/web/assets/'] },
  zoho: { category: 'crm', patterns: ['zoho.com', 'zohopublic', 'salesiq.zoho'] },
  hubspot: { category: 'crm', patterns: ['js.hs-scripts.com', 'hubspot.com', 'hs-analytics'] },
  salesforce: { category: 'crm', patterns: ['salesforce.com', 'force.com'] },
  pipedrive: { category: 'crm', patterns: ['pipedrive.com'] },
  gohighlevel: { category: 'crm', patterns: ['leadconnectorhq.com', 'msgsndr.com', 'gohighlevel.com'] },
  intercom: { category: 'chat', patterns: ['intercom.io', 'intercomcdn.com'] },
  drift: { category: 'chat', patterns: ['drift.com', 'driftt.com'] },
  tawk: { category: 'chat', patterns: ['tawk.to'] },
  crisp: { category: 'chat', patterns: ['crisp.chat'] },
  tidio: { category: 'chat', patterns: ['tidio.co', 'tidiochat'] },
  livechat: { category: 'chat', patterns: ['livechatinc.com'] },
  zendesk: { category: 'chat', patterns: ['zdassets.com', 'zendesk.com'] },
  whatsapp_widget: { category: 'chat', patterns: ['wa.me/', 'api.whatsapp.com'] },
  google_analytics: { category: 'analytics', patterns: ['googletagmanager.com', 'google-analytics.com'] },
  meta_pixel: { category: 'analytics', patterns: ['connect.facebook.net'] },
  stripe: { category: 'payments', patterns: ['js.stripe.com'] },
  paypal: { category: 'payments', patterns: ['paypal.com/sdk', 'paypalobjects.com'] },
  quickbooks: { category: 'accounting', patterns: ['quickbooks', 'intuit.com'] },
  xero: { category: 'accounting', patterns: ['xero.com'] },
};

const CONTACT_WORDS = ['contact', 'about', 'contacto', 'contactanos', 'nosotros', 'impressum', 'kontakt',
  'اتصل', 'تواصل', 'رابطہ', 'من-نحن', 'about-us', 'get-in-touch', 'team'];

async function snapshot(page, includeText) {
  return page.evaluate((withText) => {
    const meta = (n) => {
      const el = document.querySelector(`meta[name="${n}"],meta[property="${n}"]`);
      return el ? el.getAttribute('content') : null;
    };
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 80) }));
    const scripts = Array.from(document.querySelectorAll('script[src],iframe[src],link[href]'))
      .map((s) => s.src || s.href).filter(Boolean);
    const inline = Array.from(document.querySelectorAll('script:not([src])')).map((s) => s.textContent.slice(0, 2000)).join('\n');
    return {
      url: location.href,
      title: document.title || null,
      description: meta('description') || meta('og:description'),
      og_title: meta('og:title'),
      lang: document.documentElement.getAttribute('lang'),
      generator: meta('generator'),
      text: withText && document.body ? document.body.innerText : '',
      html_hints: `${scripts.join('\n')}\n${inline}`.slice(0, 200000),
      links,
    };
  }, includeText);
}

function detectTech(hints, sigs) {
  const hay = String(hints || '').toLowerCase();
  const found = [];
  for (const [name, sig] of Object.entries(sigs)) {
    if ((sig.patterns || []).some((p) => hay.includes(String(p).toLowerCase()))) found.push({ name, category: sig.category || 'other' });
  }
  return found;
}

module.exports = {
  type: 'scrape_website',
  platform: 'web',
  category: 'none',
  DEFAULT_TECH,
  async run(ctx) {
    const { job, payload, page } = ctx;
    if (!payload.url) throw new JobError('missing_payload_fields:url');
    let url = String(payload.url);
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const maxPages = Math.max(1, Math.min(6, Number(payload.max_pages) || 3));
    const includeText = payload.include_text !== false;
    const sigs = { ...DEFAULT_TECH, ...(payload.tech_signatures || {}) };

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ctx.behavior.humanDelay(1500, 3000, ctx.signal);
    if (job.recipe && Array.isArray(job.recipe.steps) && job.recipe.steps.length) {
      await ctx.runRecipe({ url }).catch(() => null); // optional helper steps only
    }
    const home = await snapshot(page, includeText);
    const pages = [{ url: home.url, title: home.title }];
    let allText = home.text || '';
    let hints = home.html_hints;
    const emails = new Set(findEmails(`${home.text} ${home.links.map((l) => l.href).join(' ')}`));
    const phones = new Set();
    const socials = new Set();
    const hrefs = [];
    const collectLinks = (links) => {
      for (const l of links) {
        const h = String(l.href || '');
        hrefs.push(h);
        if (h.startsWith('mailto:')) emails.add(h.slice(7).split('?')[0].toLowerCase());
        if (h.startsWith('tel:')) phones.add(h.slice(4).replace(/[^\d+]/g, ''));
        if (/instagram\.com|facebook\.com|linkedin\.com|tiktok\.com|twitter\.com|x\.com\/|youtube\.com/i.test(h)) socials.add(h.split('?')[0]);
      }
    };
    collectLinks(home.links);

    const origin = new URL(home.url).origin;
    const candidates = [...new Set(home.links
      .filter((l) => l.href.startsWith(origin) && CONTACT_WORDS.some((w) => `${l.href} ${l.text}`.toLowerCase().includes(w)))
      .map((l) => l.href.split('#')[0]))].slice(0, maxPages - 1);

    for (const link of candidates) {
      if (ctx.signal && ctx.signal.aborted) throw new Error('cancelled');
      try {
        await ctx.behavior.humanDelay(1200, 3500, ctx.signal);
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await ctx.behavior.humanDelay(800, 1800, ctx.signal);
        const snap = await snapshot(page, true);
        pages.push({ url: snap.url, title: snap.title });
        allText += `\n\n${snap.text}`;
        hints += `\n${snap.html_hints}`;
        findEmails(snap.text).forEach((e) => emails.add(e));
        collectLinks(snap.links);
      } catch (err) {
        if (err && err.message === 'cancelled') throw err;
      }
    }

    return {
      data: {
        url,
        final_url: home.url,
        http_status: resp ? resp.status() : null,
        title: clean(home.title, 300),
        description: clean(home.description, 1000),
        og_title: clean(home.og_title, 300),
        lang: home.lang || null,
        generator: clean(home.generator, 100),
        text: includeText ? clean(allText, 20000) : null,
        emails: [...emails].slice(0, 20),
        phones: [...phones].slice(0, 10),
        whatsapp_links: findWhatsappLinks(`${hrefs.join('\n')}\n${hints}\n${allText}`).slice(0, 5),
        social_links: [...socials].slice(0, 20),
        tech: detectTech(`${hints}\n${home.generator || ''}`, sigs),
        pages,
      },
    };
  },
};
