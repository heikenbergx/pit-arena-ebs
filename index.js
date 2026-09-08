'use strict';
/**
 * index.js — MULTI-TENANT Pit Arena EBS.
 *
 * ⚠⚠ READ THIS BEFORE YOU DEPLOY IT.
 * This file is the v1 server (twitch-extension/server/index.js) plus channel scoping. It is
 * NOT a fresh design: everything v1 learned the hard way is carried over deliberately, and
 * an earlier draft of this file had LOST three of those things. If you ever re-merge, check
 * all four of these are still present:
 *   1. mountBits(app), mounted EARLY  — without it /bits dies and the Bits goal bars break.
 *   2. no-store headers on GET reads  — without them a viewer's panel freezes on its first
 *                                       fetched body (the original "panel doesn't work" bug).
 *   3. /version                       — the only way to confirm a push actually deployed.
 *   4. BATTLE_TIERS = battle|lt|...   — the panel sends 'battle' and 'lt'. A draft used
 *                                       'fodder'/'veteran'/'lieutenant' and would have
 *                                       rejected every ordinary battle tap as 'unknown tier'.
 *
 * ⚠ NOTE ON NAMING: the build string below says "v2" meaning THIS SERVER'S SECOND DESIGN
 * (single-tenant → multi-tenant). It has nothing to do with Twitch EXTENSION versions
 * (v0.0.2 / v0.0.4 / v0.0.5) — those are counted separately and are not related to this file.
 * WHAT MULTI-TENANT MEANS HERE: every request resolves to a CHANNEL, and nothing is global.
 *
 * ⚠ WHERE THIS FILE GOES: it REPLACES server/index.js in the live EBS repo, sitting beside the
 * existing twitch.js and bits.js (which is why every require below is './something'). It ships
 * with store.js and tenants.js as a set — v2's store takes a channel id in every call, so the
 * three files must move together or none of them.
 *
 * ⚠ HOW TO GET BACK: the previous single-tenant server is one git revert away, and the legacy
 * bridge below means your own channel keeps working even before you switch the app to a key.
 * Snapshots are disposable (the app re-posts every fighter on any change), so nothing is lost
 * by going either direction.
 *
 *   WRITE  (streamer's app)  POST /players/:login   Bearer <arena key>   → channel from key
 *   READ   (viewer's panel)  GET  /me               Bearer <twitch JWT>  → channel from JWT
 *   ACTION (viewer's panel)  POST /action           Bearer <twitch JWT>  → channel from JWT
 *   DRAIN  (streamer's app)  GET  /actions          Bearer <arena key>   → channel from key
 *   KEY    (config view)     GET  /config/key       Bearer <twitch JWT, role=broadcaster>
 *
 * ⚠ THE SECURITY MODEL, one line each:
 *   • A streamer's app can only write to the channel encoded in its own key.
 *   • A viewer's panel can only read the channel Twitch signed into its token.
 *   • A viewer can only act as themselves, because the login comes from the token.
 *   • Only the real broadcaster can fetch a channel's key, because Twitch says who they are.
 * No request is trusted to name its own channel. That is the whole design.
 */

// Minimal .env loader (no dependency) — reads KEY=value lines if a .env exists.
(function loadEnv() {
  try {
    const fs = require('fs');
    const txt = fs.readFileSync(require('path').join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* no .env — rely on real environment variables (how hosts inject them) */ }
})();

const https = require('https');
const express = require('express');
const cors = require('cors');
const store = require('./store');
const tenants = require('./tenants');
const twitch = require('./twitch');

// ⚠⚠ BITS IS LOADED DEFENSIVELY, ON PURPOSE — READ BEFORE "FIXING" THIS.
// bits.js lives ONLY in the live EBS repo; it is not in the design project, so a plain
// top-level require would crash the whole server anywhere else. And a hard require makes a
// missing bits.js fatal: the arena — every viewer's panel, every snapshot — would go down
// because a Bits goal bar module was absent. That trade is backwards.
//
// So: mounted if present, LOUDLY skipped if not. What must never happen is this block being
// deleted, which is what silently kills /bits while everything else keeps working.
let mountBits = null;
try {
  mountBits = require('./bits').mountBits;
} catch (e) {
  console.error('[ebs] ⚠ bits.js NOT FOUND — /bits and /bits2 will 404 and the Bits goal bar');
  console.error('[ebs]   overlays will stop updating. The arena is unaffected. Reason:', e.message);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── CORS: allow Twitch panel origins (https://<clientid>.ext-twitch.tv) ──────
const allowed = (process.env.ALLOWED_ORIGINS || '*.ext-twitch.tv')
  .split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true;               // curl / server-to-server / the app's own relay
  try {
    const host = new URL(origin).host;
    return allowed.some(pat =>
      pat === '*' ||
      (pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat));
  } catch { return false; }
}
app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin)) }));

store.init();

const DEV_LOGIN_QUERY = process.env.DEV_ALLOW_LOGIN_QUERY === '1';
const DEV_CHANNEL = process.env.DEV_CHANNEL_ID || '';

// ── LEGACY BRIDGE: your own channel keeps working during the switchover ──────
// Set LEGACY_CHANNEL_ID to your numeric channel id and keep OVERLAY_SECRET in place, and the
// old shared secret still authorises writes — but ONLY for that one channel. This exists so
// you can deploy the multi-tenant server without touching your live app in the same minute;
// your fighters keep posting while you swap the app over to a real arena key at your leisure.
// ⚠ DELETE BOTH ENV VARS once your app is on a key. A shared secret that still works is a
// shared secret someone can still use.
const LEGACY_SECRET = process.env.OVERLAY_SECRET || '';
const LEGACY_CHANNEL = process.env.LEGACY_CHANNEL_ID || '';

/**
 * Is this channel running the arena?
 *
 * ⚠⚠ THE LEGACY CHANNEL IS ALWAYS "KNOWN", AND THIS CLOSES A REAL REGRESSION WINDOW.
 * v2's store file is channel-nested, so the v1 flat snapshots.json does NOT load into it — on
 * the first boot after deploying v2, the store is EMPTY. Without this override, every viewer on
 * your channel would be told "this channel isn't running the arena" for the seconds or minutes
 * until your app's first post lands... and for as long as you happen to be offline when you
 * deploy. Naming your own channel in LEGACY_CHANNEL_ID makes that window disappear.
 */
function channelKnown(cid) {
  if (LEGACY_CHANNEL && String(cid) === String(LEGACY_CHANNEL)) return true;
  return store.channelKnown(cid);
}

const ACTION_TYPES = ['equip', 'lock', 'upgrade', 'battle', 'train', 'buy', 'ascend'];
// ⚠ THESE ARE THE PANEL'S OWN TIER NAMES. Do not "tidy" them into prettier words — panel.js
// sends these exact strings, and the game's command paths expect them.
const BATTLE_TIERS = ['battle', 'lt', 'boss', 'nightmare', 'raid'];

/**
 * Resolve the channel for a WRITE-side request (the streamer's app), or answer 401.
 * Returns the channel id, or null when it has already sent the response.
 */
function writeChannel(req, res) {
  const raw = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const cid = tenants.channelFromAuth(req.get('authorization'));
  if (cid) return cid;
  if (LEGACY_SECRET && LEGACY_CHANNEL && raw === LEGACY_SECRET) return String(LEGACY_CHANNEL);
  // Distinguish the three failures — "bad key" alone sent people hunting for typos when the
  // real answer was "you pasted the old secret" or "you revoked this one".
  let why = 'no key sent';
  if (raw && !tenants.looksLikeKey(raw)) {
    why = 'that is not an arena key — get yours from the extension config view on your Twitch dashboard';
  } else if (raw) {
    why = 'arena key not recognised (it may have been revoked — re-copy it from the config view)';
  }
  res.status(401).json({ ok: false, error: why });
  return null;
}

// ── Bits leaderboard poller ──────────────────────────────────────────────────
// Adds GET /bits and GET /bits2 (plus /health on each) for the goal bar overlays. Mounted
// early so it sits ahead of everything else, and it sets its own permissive CORS header since
// StreamElements is not a *.ext-twitch.tv origin. Does nothing if the BITS_ env vars are absent.
//
// ⚠ THESE THREE LINES ARE EASY TO LOSE (the loader above and the call below). Paste this file
// from an older copy and /bits starts returning "Cannot GET /bits" while everything else keeps
// working — a silent break in two overlays that have nothing to do with the arena.
// ⚠ The bits feed is deliberately NOT per-channel: it polls YOUR channel's Bits leaderboard
// from YOUR credentials. Another streamer's app never touches it, and their key cannot reach it.
if (mountBits) mountBits(app);

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'pit-arena-ebs',
    tenancy: 'multi',
    ...store.stats(),
    keysConfigured: tenants.hasMaster(),
    twitchConfigured: twitch.hasSecret,
    legacyBridge: !!(LEGACY_SECRET && LEGACY_CHANNEL)
  });
});

// ⚠ NEVER LET A READ BE CACHED. The panel polls one unchanging URL (/me) and express sends an
// ETag but no Cache-Control, so a browser is entitled to apply heuristic freshness and serve
// the previous body WITHOUT revalidating. That is invisible from the server side and looks
// exactly like the app never posting: the panel shows a character frozen at whatever it first
// fetched, while /players/:login proves the stored snapshot is current and correct.
// Applies to every read path a client polls.
app.use(['/me', '/players', '/actions', '/config'], (req, res, next) => {
  if (req.method === 'GET') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

// ── VERSION: open this in any browser to confirm what is actually deployed ───
// No auth on purpose: it reveals nothing but a build string, and "is my push live yet?" was
// otherwise unanswerable without guessing from behaviour.
app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    build: 'ebs multi-tenant build 1 — per-channel keys + no-store on reads + bits feed',
    tenancy: 'multi',
    at: new Date().toISOString()
  });
});

// ── KEY DELIVERY ─────────────────────────────────────────────────────────────
// The extension's CONFIG view calls this. Twitch signs role + channel_id, so this is the one
// place a key can be handed out safely: we are not taking the caller's word for anything.
app.get('/config/key', (req, res) => {
  try {
    const claims = twitch.verifyPanelToken(req.get('authorization'));
    if (claims.role !== 'broadcaster') {
      return res.status(403).json({ ok: false, error: 'broadcaster only' });
    }
    if (!tenants.hasMaster()) {
      return res.status(503).json({ ok: false, error: 'server not configured for keys' });
    }
    res.json({
      ok: true,
      channelId: claims.channel_id,
      key: tenants.keyFor(claims.channel_id),
      fighters: store.countChannel(claims.channel_id),
      live: channelKnown(claims.channel_id),
      lastSeen: store.lastSeen(claims.channel_id)
    });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// ⚠⚠ THIS MUST MATCH THE CLIENT ID IN THE APP'S oauth.js. It is the entire security of the
// login route: see the client_id check in /config/key-oauth below.
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'ujoeohx1jk85xe6y12n3fmwj17e4vx';

/** Ask Twitch who a user access token belongs to. Built-in https — no new dependency. */
function validateTwitchToken(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'id.twitch.tv', path: '/oauth2/validate', method: 'GET',
      headers: { Authorization: 'OAuth ' + token }
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('that Twitch login has expired — try again'));
        if (res.statusCode !== 200) return reject(new Error('Twitch rejected the login (' + res.statusCode + ')'));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('unreadable response from Twitch')); }
      });
    });
    req.on('error', e => reject(new Error('could not reach Twitch: ' + e.message)));
    req.setTimeout(8000, () => req.destroy(new Error('Twitch timed out')));
    req.end();
  });
}

/**
 * Trade a Twitch login for this channel's arena key.
 *
 * ⚠⚠ THE client_id CHECK BELOW IS NOT OPTIONAL AND MUST NEVER BE REMOVED.
 * /oauth2/validate happily validates a token minted by ANY Twitch application. Without the
 * check, anyone could take a token their own app obtained — from any user, for any purpose —
 * and replay it here to be handed that user's arena key. Confirming the token was issued to
 * OUR client id is what makes "Twitch says this is them" mean "they used our login button".
 *
 * ⚠ A user's own channel id IS their user id on Twitch, which is why no channel lookup is
 * needed — and why this can only ever return the caller's own key.
 */
app.post('/config/key-oauth', async (req, res) => {
  try {
    if (!tenants.hasMaster()) {
      return res.status(503).json({ ok: false, error: 'server not configured for keys' });
    }
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'no login token sent' });

    const v = await validateTwitchToken(token);
    if (String(v.client_id || '') !== String(OAUTH_CLIENT_ID)) {
      console.warn('[key-oauth] ⚠ token from a DIFFERENT client id:', v.client_id);
      return res.status(403).json({ ok: false, error: 'that login came from a different application' });
    }
    if (!v.user_id) return res.status(403).json({ ok: false, error: 'Twitch did not identify that login' });

    console.log(`[key-oauth] issued key to ${v.login} (${v.user_id})`);
    res.json({
      ok: true,
      key: tenants.keyFor(v.user_id),
      channelId: String(v.user_id),
      login: v.login || ''
    });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// Revoke: mints a new key for this channel and kills the old one. For "I pasted my key in a
// screenshot" — the streamer just re-copies from the config view.
app.post('/config/revoke', (req, res) => {
  try {
    const claims = twitch.verifyPanelToken(req.get('authorization'));
    if (claims.role !== 'broadcaster') {
      return res.status(403).json({ ok: false, error: 'broadcaster only' });
    }
    if (!tenants.hasMaster()) {
      return res.status(503).json({ ok: false, error: 'server not configured for keys' });
    }
    const r = tenants.bumpRev(claims.channel_id);
    console.log(`[config] channel ${claims.channel_id} revoked → rev ${r.rev}`);
    res.json({
      ok: true,
      key: tenants.keyFor(claims.channel_id),
      // Told the truth rather than hidden: if the disk write failed, the old key comes back
      // to life on the next restart and the streamer needs to know to revoke again.
      persisted: r.persisted
    });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// ── WRITE ────────────────────────────────────────────────────────────────────
app.post('/players/:login', (req, res) => {
  const cid = writeChannel(req, res);
  if (!cid) return;
  const login = String(req.params.login || '').toLowerCase();
  if (!login) return res.status(400).json({ ok: false, error: 'missing login' });
  const snap = req.body;
  if (!snap || typeof snap !== 'object') return res.status(400).json({ ok: false, error: 'bad body' });
  store.put(cid, login, snap);
  res.json({ ok: true, login });
});

// Bulk push (optional): app can send { players: { login: snapshot, ... } }.
app.post('/players', (req, res) => {
  const cid = writeChannel(req, res);
  if (!cid) return;
  const bag = (req.body && req.body.players);
  if (!bag || typeof bag !== 'object') return res.status(400).json({ ok: false, error: 'missing players' });
  let n = 0;
  for (const [login, snap] of Object.entries(bag)) {
    if (snap && typeof snap === 'object') { store.put(cid, login, snap); n++; }
  }
  res.json({ ok: true, saved: n });
});

// ── READ: the panel asks "what do I own?" ────────────────────────────────────
app.get('/me', async (req, res) => {
  try {
    let login = null;
    let channelId = null;

    // Dev/local preview path (never in production): /me?login=grom
    if (DEV_LOGIN_QUERY && req.query.login) {
      login = String(req.query.login).toLowerCase();
      channelId = String(req.query.channel || DEV_CHANNEL || '');
    } else {
      const claims = twitch.verifyPanelToken(req.get('authorization'));
      channelId = claims.channel_id;
      if (!claims.user_id) {
        // Viewer hasn't shared identity yet — panel shows its "link me" prompt.
        return res.json({ ok: true, state: 'needs_identity' });
      }
      login = await twitch.loginForUserId(claims.user_id);
      if (!login) return res.json({ ok: true, state: 'no_login' });
    }

    // ⚠ TWO DIFFERENT NOTHINGS, AND THE PANEL SAYS DIFFERENT THINGS FOR THEM.
    // "This channel has never run the arena" is not the same as "you haven't joined yet".
    // Telling a viewer on a channel with no arena to type !battle in chat is advice that will
    // never work and makes the extension look broken. The channel counts as known as soon as
    // its app posts once, so this heals itself the moment a streamer goes live.
    if (!channelKnown(channelId)) {
      return res.json({ ok: true, state: 'no_arena', login });
    }

    const snap = store.get(channelId, login);
    if (!snap) return res.json({ ok: true, state: 'no_character', login });
    res.json({ ok: true, state: 'ok', login, player: snap });
  } catch (e) {
    console.error('[/me]', e.message);
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// ── ACTION: panel asks to equip / fight / train / buy as the viewer ──────────
// Auth: the viewer's Twitch JWT — the login is derived from the token, so a viewer can only
// ever act on their own character, never someone else's.
app.post('/action', async (req, res) => {
  try {
    let login = null;
    let channelId = null;
    if (DEV_LOGIN_QUERY && req.query.login) {
      login = String(req.query.login).toLowerCase();
      channelId = String(req.query.channel || DEV_CHANNEL || '');
    } else {
      const claims = twitch.verifyPanelToken(req.get('authorization'));
      channelId = claims.channel_id;
      if (!claims.user_id) return res.json({ ok: true, state: 'needs_identity' });
      login = await twitch.loginForUserId(claims.user_id);
      if (!login) return res.json({ ok: true, state: 'no_login' });
    }
    if (!channelKnown(channelId)) {
      return res.status(409).json({ ok: false, error: 'this channel is not running the arena' });
    }

    const b = req.body || {};
    const type = String(b.type || '');
    if (ACTION_TYPES.indexOf(type) < 0) return res.status(400).json({ ok: false, error: 'bad type' });

    // ⚠ VALIDATE AND CLAMP HERE, don't pass the body through. The game re-checks gold, stock,
    // queue position, turn caps and cooldowns on its own side, so nothing here can grant
    // anything — but an unbounded string or index still reaches the app's own parsing, and
    // bounding it at the door is free.
    const action = { login, type, at: Date.now() };
    if (type === 'train' || type === 'ascend') {
      // No payload. The app runs the same !train / !ascend paths, which do their own gold,
      // level-cap and max-ascension checks. Nothing here can be spoofed into a free level.
    } else if (type === 'buy') {
      const n = parseInt(b.index, 10);            // shop slot (stock is 3; headroom to 10)
      if (!(n >= 1 && n <= 10)) return res.status(400).json({ ok: false, error: 'bad shop slot' });
      action.index = n;
    } else if (type === 'battle') {
      const tier = String(b.tier || 'battle').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
      action.tier = BATTLE_TIERS.indexOf(tier) >= 0 ? tier : 'battle';
    } else if (type === 'upgrade') {
      const slot = String(b.slot || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
      if (!slot) return res.status(400).json({ ok: false, error: 'bad slot' });
      action.slot = slot;
    } else {                                       // equip | lock
      const index = parseInt(b.index, 10);
      if (!(index >= 1 && index <= 50)) return res.status(400).json({ ok: false, error: 'bad index' });
      action.index = index;
      action.name = b.name ? String(b.name).slice(0, 80) : null;
      if (type === 'lock') action.want = (typeof b.want === 'boolean') ? b.want : null;
    }

    const ok = store.pushAction(channelId, action);
    if (!ok) return res.status(429).json({ ok: false, error: 'action queue full — is the app running?' });
    res.json({ ok: true, queued: true });
  } catch (e) {
    console.error('[/action]', e.message);
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// ── DRAIN: the app pulls & clears its own channel's pending actions ──────────
app.get('/actions', (req, res) => {
  const cid = writeChannel(req, res);
  if (!cid) return;
  res.json({ ok: true, actions: store.drainActions(cid) });
});

// ── ADMIN: season reset, scoped to the caller's own channel ──────────────────
app.post('/admin/clear', (req, res) => {
  const cid = writeChannel(req, res);
  if (!cid) return;
  const cleared = store.clearChannel(cid);
  console.log(`[admin] channel ${cid} reset — cleared ${cleared} players`);
  res.json({ ok: true, cleared });
});

// Debug read, scoped to the key's own channel.
app.get('/players/:login', (req, res) => {
  const cid = writeChannel(req, res);
  if (!cid) return;
  res.json(store.get(cid, req.params.login) || { state: 'no_character' });
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`[pit-arena-ebs multi] listening on :${PORT}`);
  console.log(`  write  : POST /players/:login   (Bearer arena key)`);
  console.log(`  read   : GET  /me               (Bearer twitch JWT)`);
  console.log(`  action : POST /action           (Bearer twitch JWT)`);
  console.log(`  drain  : GET  /actions          (Bearer arena key)`);
  console.log(`  key    : GET  /config/key       (Bearer twitch JWT, broadcaster)`);
  console.log(`  bits   : GET  /bits, /bits2     (public, CORS open)`);
  console.log(`  keys configured   : ${tenants.hasMaster()}`);
  console.log(`  twitch configured : ${twitch.hasSecret}`);
  if (LEGACY_SECRET && LEGACY_CHANNEL) {
    console.log(`  ⚠ legacy bridge ACTIVE for channel ${LEGACY_CHANNEL} — remove once the app uses a key`);
  }
});

// Flush the store on shutdown so no in-flight writes are lost.
function shutdown() { store.flush(); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
