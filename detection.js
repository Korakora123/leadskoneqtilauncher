'use strict';
/**
 * Challenge / block detection (captcha, "unusual activity", restrictions, logout).
 * Multi-language: English, Arabic, Spanish, Urdu (+ a few common others).
 * Pure Playwright; no Electron imports.
 */

const PHRASES = {
  unusual_activity: [
    // en
    'unusual activity', 'suspicious activity', 'automated behavior', 'automated activity',
    'verify it\'s you', 'verify it’s you', 'confirm it\'s you', 'confirm it’s you',
    'confirm your identity', 'security check', 'let us know you\'re human',
    'are you a robot', 'not a robot', 'help us confirm',
    // ar
    'نشاط غير عادي', 'نشاط غير معتاد', 'نشاط مريب', 'تأكيد هويتك', 'تحقق من هويتك',
    'تأكد من أنك', 'لست روبوت', 'فحص أمني',
    // es
    'actividad inusual', 'actividad sospechosa', 'verifica que eres tú', 'verifica que eres tu',
    'confirma que eres tú', 'confirma tu identidad', 'no soy un robot', 'comprobación de seguridad',
    // ur
    'غیر معمولی سرگرمی', 'مشکوک سرگرمی', 'تصدیق کریں کہ یہ آپ ہیں', 'اپنی شناخت کی تصدیق',
    // pt / fr / tr
    'atividade incomum', 'activité inhabituelle', 'olağan dışı etkinlik',
  ],
  rate_limited: [
    'try again later', 'please wait a few minutes', 'you\'ve reached the limit', 'you have reached the limit',
    'too many requests', 'slow down', 'weekly invitation limit', 'reached the weekly limit',
    'حاول مرة أخرى لاحقًا', 'حاول مرة أخرى لاحقا', 'الرجاء المحاولة لاحقاً', 'طلبات كثيرة جدًا',
    'inténtalo de nuevo más tarde', 'intentalo de nuevo mas tarde', 'vuelve a intentarlo más tarde', 'demasiadas solicitudes',
    'بعد میں دوبارہ کوشش کریں', 'تھوڑی دیر بعد کوشش کریں',
    'tente novamente mais tarde', 'réessayez plus tard',
  ],
  action_blocked: [
    'we restrict certain activity', 'action blocked', 'this action was blocked', 'you\'re temporarily blocked',
    'you are temporarily blocked', 'your account has been restricted', 'account restricted',
    'temporarily restricted', 'you can\'t use this feature', 'feature temporarily blocked',
    'we limit how often', 'your account has been suspended', 'account suspended',
    'نقيد بعض الأنشطة', 'نحن نقيد', 'تم حظر الإجراء', 'تم تقييد حسابك', 'محظور مؤقتًا', 'تم تعليق حسابك',
    'restringimos ciertas actividades', 'acción bloqueada', 'accion bloqueada', 'bloqueado temporalmente',
    'tu cuenta ha sido restringida', 'cuenta suspendida',
    'ہم کچھ سرگرمیوں کو محدود کرتے ہیں', 'کارروائی بلاک', 'آپ کا اکاؤنٹ محدود', 'عارضی طور پر بلاک',
    'restringimos determinadas atividades', 'ação bloqueada',
  ],
};

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[title*="captcha" i]',
  'div.g-recaptcha',
  'div.h-captcha',
  '#captcha-internal',
  '[id*="arkose" i]',
  'input[name="cf-turnstile-response"]',
];

const URL_PATTERNS = [
  { re: /\/checkpoint\/|\/challenge\/|\/challenge\?|captcha|\/sorry\/index|\/authwall/i, warning: 'unusual_activity' },
  { re: /\/accounts\/suspended|\/restricted|\/account\/restricted/i, warning: 'action_blocked' },
  { re: /\/accounts\/login|\/login\b|\/uas\/login|\/signin|login\.php|\/login\?/i, warning: 'logged_out' },
];

const PLATFORM_HOSTS = {
  instagram: /instagram\.com/i,
  linkedin: /linkedin\.com/i,
  facebook: /facebook\.com|fb\.com/i,
  tiktok: /tiktok\.com/i,
};

/**
 * Inspect the page for challenges.
 * @returns {Promise<{warnings: string[], events: {event:string, detail:string}[]}>}
 */
async function detectChallenges(page, { platform, textChecks = Boolean(platform) } = {}) {
  const warnings = new Set();
  const events = [];
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return { warnings: [], events };

  let url = '';
  try { url = page.url(); } catch (_) { /* ignore */ }

  // URL-based
  for (const { re, warning } of URL_PATTERNS) {
    if (!re.test(url)) continue;
    // Only treat /login as logged_out on the social platform the job targets.
    if (warning === 'logged_out' && platform && PLATFORM_HOSTS[platform] && !PLATFORM_HOSTS[platform].test(url)) continue;
    if (warning === 'logged_out' && !platform) continue;
    warnings.add(warning);
  }

  // Captcha iframes / widgets
  try {
    for (const sel of CAPTCHA_SELECTORS) {
      const n = await page.locator(sel).count();
      if (n > 0) {
        warnings.add('captcha_detected');
        break;
      }
    }
  } catch (_) { /* page may be navigating */ }

  // Visible text phrases (only on social platforms — normal websites say "try again later" too)
  if (textChecks) try {
    const text = (await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 60000)))
      .toLowerCase();
    for (const [warning, list] of Object.entries(PHRASES)) {
      if (list.some((p) => text.includes(p.toLowerCase()))) warnings.add(warning);
    }
  } catch (_) { /* ignore */ }

  const w = [...warnings];
  if (w.includes('captcha_detected')) events.push({ event: 'captcha', detail: 'captcha widget on page' });
  if (w.includes('unusual_activity')) events.push({ event: 'challenge', detail: 'unusual activity / verification prompt' });
  if (w.includes('action_blocked')) events.push({ event: 'restricted', detail: 'action blocked / account restricted' });
  if (w.includes('logged_out')) events.push({ event: 'logged_out', detail: 'redirected to login' });
  return { warnings: w, events };
}

/** Warnings that must stop the job with status 'blocked'. */
const BLOCKING_WARNINGS = ['captcha_detected', 'unusual_activity', 'action_blocked', 'logged_out', 'rate_limited'];

module.exports = { detectChallenges, PHRASES, CAPTCHA_SELECTORS, BLOCKING_WARNINGS };
