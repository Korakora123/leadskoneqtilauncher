# Koneqti Leads — Desktop Launcher (Electron)

Part 2 of the Koneqti Leads architecture. The launcher runs silently in the system
tray on the user's PC, connects to the **brain** (Windows VPS, port 4100) over
WebSocket, and executes browser jobs (scraping, DMs, warm-path actions, proof
screenshots, video frames) with the user's **own Chrome and residential IP**.

```
Brain (Windows VPS :4100)  ── ws://…/ws  job ─────▶  Launcher (this app, user PC)
                           ◀── job_result / events ──   Playwright + local Chrome
Launcher ── POST /api/electron/uploads (PNG screenshots / video frames) ──▶ Brain
```

## Install & run (dev)

```bash
npm install                 # playwright-core never downloads browsers
cp .env.example .env        # fill BRAIN_WS_URL, BRAIN_HTTP_URL, ELECTRON_SECRET, SUPABASE_*
npm start                   # electron .
```

Requirements: Node 20+, Google Chrome installed (or `CHROME_PATH`).
Optional stealth engines: `npm install cloakbrowser` and/or
`npm install camoufox-js && npx camoufox-js fetch`. Without them those engines fall
back to `chromium_patched` (logged).

## Build installers

```bash
npm run icon      # regenerates assets/icon.png (256) + assets/icon-512.png
npm run dist      # electron-builder: Windows (nsis), macOS (dmg), Linux (AppImage + deb)
```

The installed app reads its config from `<userData>/.env` (then the app resources dir).
`<userData>` is e.g. `%APPDATA%/Koneqti Leads` (Windows),
`~/Library/Application Support/Koneqti Leads` (macOS), `~/.config/Koneqti Leads` (Linux).

## Config

| Var | Purpose |
|---|---|
| `BRAIN_WS_URL` | `ws://[WINDOWS_VPS_IP]:4100/ws` |
| `BRAIN_HTTP_URL` | `http://[WINDOWS_VPS_IP]:4100` (uploads, voice-note downloads) |
| `ELECTRON_SECRET` | sent as `x-electron-secret` (WS) / `X-Electron-Secret` (HTTP) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | user login (email + password) |
| `DASHBOARD_URL` | `https://leads.koneqti.com` |
| `JOB_CONCURRENCY` | 1–2 parallel browser jobs (default 1) |
| `KONEQTI_HEADLESS=1` | headless browsers (testing only) |
| `CHROME_PATH` | override Chrome executable |

## Security model

- **No intelligence stored locally.** Recipes (selectors + steps) arrive inside each
  `job` message, are executed in memory and discarded — never written to disk.
- **No API keys stored.** Only the user's own Supabase session (encrypted with the OS
  keychain via Electron `safeStorage` when available), a `device_id`, app settings and
  profile *metadata* (id, platform, handle, engine, fingerprint seed, proxy, warmup
  start, working hours, daily counters).
- Each profile's browser user-data dir (cookies/logins) stays on this PC and is never
  auto-cleared; it is deleted only when the user removes the profile.
- Logs contain job ids + statuses only — never tokens, cookies or message text.
- Renderer is sandboxed (`contextIsolation`, no Node, strict CSP); it only sees the
  `window.koneqti` IPC bridge.

## Anti-bot engineering

- **BrowserAdapter** (`browser/adapter.js`) — the only way jobs get a browser.
  Engines: `cloakbrowser` | `camoufox` | `chromium_patched` (local Chrome via
  playwright-core, `--disable-blink-features=AutomationControlled`, no
  `--enable-automation`, `navigator.webdriver` masked).
- **Identity**: 1 profile = 1 fingerprint seed (generated once) = 1 IP for life.
  Viewport/screen/hardware hints derive deterministically from the seed; locale +
  timezone follow the system (matches the user's IP) unless the profile has a proxy.
- **Behavior engine** (`behavior.js`): `humanDelay`, `humanType` (per-char variance +
  thinking pauses), `humanScroll`, `humanMove`, `readingTime`, `sessionWindow`.
- **Local hard stops** (in addition to brain): one job per profile at a time; daily
  action limits Instagram 20, LinkedIn 20, Facebook 15, TikTok 15 (brain's `welcome.limits`
  can only lower them) × warmup (week1 25%, week2 50%, week3 75%, week4+ 100%); page views
  capped at 5× that; jobs only inside the profile's working hours; counters reset at
  local midnight.
- **Challenge detection** (`detection.js`): captcha iframes (reCAPTCHA / hCaptcha /
  Arkose / Turnstile), "unusual activity / verify it's you / try again later / we restrict
  certain activity" in English, Arabic, Spanish, Urdu (+pt/fr/tr), checkpoint/login
  redirects → `job_result.warnings` + `account_event`; the profile is paused locally
  (captcha/challenge 24h, restricted 7d, logged-out until the user re-opens its browser).
- **AI selector fallback**: when every selector of a step fails, a ≤15KB accessibility
  tree (ARIA snapshot + DOM outline) is sent as `ai_selector_request`; the brain answers
  with one selector (30s timeout) and the step is retried once.

## Recipe format (executed by `recipe-executor.js`)

`recipe = { id, version, steps: [...] }`. Actions: `goto, click, type, wait_for, scroll,
extract, screenshot, press, delay, upload_file, check_text, hover`. Selector-based
steps try `selectors[]` in order (CSS, Playwright selectors, `//xpath`).
Flags: `optional`, `only_if: "{{var}}"`, `skip_if_done: "<step id>"`, `human`,
`on_match: "abort_blocked"` (check_text → job status `blocked`), `goal` (AI fallback hint).
Aliases: `type.text`, `check_text.phrases`, `scroll.target`, `scroll.until_text`,
extract field `attr: "text"`, `all: true`. `times` / `limit` / `timeout_ms` may be
template strings (`"{{max_results}}"`). Template vars = `job.payload` + per-job extras.
Extract results are stored under `save_as` or the step id.

## Job types (CONTRACTS.md §3)

All results: `job_result { job_id, status: success|failed|blocked|skipped, data, error?, warnings?, recipe_version?, failed_step? }`.
`data._meta = { engine, fallback_from, profile_id, duration_ms, ai_selectors_used?, skipped_steps? }`.

| Job type | Recipe | Payload | Result `data` |
|---|---|---|---|
| `scrape_google_maps` | required | `query, location?, max_results?, area_id?, niche?, lat?, lng?` | `{ query, location, area_id, niche, count, results:[{ name, rating, reviews_count, category, address, phone, website, maps_url, no_website }] }` |
| `check_gbp` | required | `maps_url\|gbp_url, prospect_id?, max_reviews?` | `{ prospect_id, url, name, rating, reviews_count, category, address, website, phone, hours_text, last_post_date_text, last_post_at, has_booking_link, booking_url, owner_response_rate, reviews:[{ author, text, stars, date_text, date, has_owner_response, owner_response }], checked_at }` |
| `scrape_instagram` | required | `mode: hashtag\|profile, hashtag?, handle?, max_results?` | `{ mode, hashtag, handle, profiles:[{ handle, full_name, bio, category, followers, following, posts_count, external_url, dm_to_order, whatsapp_links, price_question_count, recent_posts }], posts:[{ url, author, caption, likes, comments_count, price_questions, posted_at }] }` |
| `scrape_linkedin` | required | `mode: profile\|company\|search, url?, query?, search_type?, max_results?` | `{ mode, url, profile?, company?, results? }` (count fields parsed to ints) |
| `scrape_facebook_groups` | required (run per group) | `group_urls[], keywords?, max_posts_per_group?` | `{ groups_checked, failed_groups, posts:[{ group_url, author, author_url, text, posted_at_text, posted_at, url, matched_keywords }] }` |
| `scrape_tiktok` | required | `mode: hashtag\|profile\|search, hashtag?, handle?, query?, max_results?` | `{ mode, profiles:[…], videos:[{ url, author, caption, views, likes, comments_count, posted_at }] }` |
| `scrape_job_posts` | optional (JSON-LD fallback) | `urls[]\|url, query?, location?, source?, keywords?, max_results?` | `{ count, jobs:[{ title, company, location, description, posted_at_text, posted_at, url, employment_type, source, source_url, matched_keywords }], failed_urls }` |
| `scrape_website` | optional (helper) | `url, max_pages?, include_text?, tech_signatures?` | `{ url, final_url, http_status, title, description, og_title, lang, generator, text, emails, phones, whatsapp_links, social_links, tech:[{ name, category }], pages }` |
| `check_social_profile` | required | `platform, handle?\|url?` | `{ platform, handle, url, followers, following, posts_count, last_post_at, avg_engagement, engagement_rate, median_engagement, viral_posts, recent_posts, checked_at }` |
| `send_instagram_dm` | required | `handle, message, prospect_id?` | `{ sent, sent_at, platform, recipient, prospect_id }` |
| `send_linkedin_message` | required | `profile_url, message, subject?, prospect_id?` | `{ sent, sent_at, platform, recipient, prospect_id }` |
| `send_linkedin_connect` | required | `profile_url, note? (≤300), prospect_id?` | `{ sent, requested, with_note, sent_at, recipient, prospect_id }` |
| `send_linkedin_voice_note` | required | `profile_url, audio_url, caption?, duration_sec?, prospect_id?` | `{ sent, voice_note, sent_at, recipient, duration_sec, prospect_id }` |
| `send_facebook_dm` | required | `profile_url\|handle, message, prospect_id?` | `{ sent, sent_at, platform, recipient, prospect_id }` |
| `community_engage` | required | `platform, post_url, comment, prospect_id?` | `{ sent, commented, post_url, sent_at }` |
| `content_like` | required | `platform, post_url, prospect_id?` | `{ sent, liked, post_url, sent_at }` |
| `capture_proof_screenshots` | optional (per target) | `prospect_id, kind?, targets:[{ name, url?\|html?, selector?, full_page?, wait_ms?, width?, height? }]` | `{ prospect_id, files:[{ name, source_url, width, height, url, path }], failed }` |
| `capture_video_frames` | — | `prospect_id, video_id?, width?=1280, height?=720, frames:[{ name, url?\|html?, selector?, wait_ms? }]` | `{ prospect_id, video_id, width, height, frames:[{ index, name, url, path }] }` |
| `canary_routine` | optional | `platform, routine?: feed\|messages\|both` | `{ platform, visited, logged_in, challenges, healthy, checked_at }` |

Action jobs whose recipe saves `state: { already_connected | already_sent | already_liked | cannot_message: true }`
finish as `skipped` with `data: { sent: false, state }`. Common `error` codes:
`recipe_required`, `missing_payload_fields:<f>`, `platform_paused`, `device_paused`,
`daily_limit_reached` (+ warning `rate_limited`), `outside_working_hours`,
`profile_needs_attention:<reason>`, `no_profile_for_platform:<p>`, `deadline_passed`,
`cancelled`, `job_timeout`, `selector_failed`, `browser_launch_failed`.

## Validation

```bash
npm run check    # requires every non-Electron module, syntax-checks Electron files,
                 # verifies the job registry == CONTRACTS job types, no electron imports in executor code
npm run smoke    # fake-brain WebSocket test + headless recipe/runner tests + seeded-recipe tests
```

## Layout

```
main.js  preload.js  tray.js  auth.js  store.js  logger.js
websocket-client.js  playwright-runner.js  recipe-executor.js  behavior.js  detection.js
profile-manager.js  uploader.js
browser/adapter.js  browser/fingerprint.js  browser/engines/{cloakbrowser,camoufox,chromium-patched}.js
jobs/index.js + one module per job type
renderer/{login.html, profiles.html, renderer.js, styles.css}
assets/icon.png  scripts/{make-icon,check}.js  test/{smoke-ws,smoke-recipe,smoke-seeds}.js
```

`jobs/*`, `recipe-executor.js`, `playwright-runner.js`, `browser/*`, `behavior.js` and
`detection.js` import nothing from Electron, so a future cloud executor can reuse them.
