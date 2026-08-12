'use strict';
/**
 * Pit Arena EBS (Extension Backend Service) — the "helper server".
 *
 * Two jobs:
 *   • WRITE side  (from your OBS overlay):  POST /players/:login
 *       Protected by OVERLAY_SECRET so only you can write.
 *   • READ side   (from the viewer's panel): GET /me
 *       Protected by the Twitch-signed JWT so a viewer only sees their own data.
 *
 * Everything the panel shows is precomputed by the overlay and stored as-is,
 * so this server never needs to know the game's rules — it's just a mailbox.
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
const express = require('express');
const cors = require('cors');
const store = require('./store');
const twitch = require('./twitch');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ── CORS: allow Twitch panel origins (https://<clientid>.ext-twitch.tv) ──────
const allowed = (process.env.ALLOWED_ORIGINS || '*.ext-twitch.tv')
  .split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return true;               // curl / server-to-server
  try {
    const host = new URL(origin).host;
    return allowed.some(pat =>
      pat === '*' ||
      (pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat));
  } catch { return false; }
}
app.use(cors({ origin: (origin, cb) => cb(null, originAllowed(origin)) }));

store.init();

const OVERLAY_SECRET = process.env.OVERLAY_SECRET || '';
const DEV_LOGIN_QUERY = process.env.DEV_ALLOW_LOGIN_QUERY === '1';

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'pit-arena-ebs', players: store.count() });
});

// ── WRITE: overlay pushes a player's snapshot ────────────────────────────────
// Header:  Authorization: Bearer <OVERLAY_SECRET>
// Body:    the panel-ready snapshot object (see overlay-sync.js -> publicView()).
app.post('/players/:login', (req, res) => {
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!OVERLAY_SECRET || auth !== OVERLAY_SECRET) {
    return res.status(401).json({ error: 'bad overlay secret' });
  }
  const login = String(req.params.login || '').toLowerCase();
  if (!login) return res.status(400).json({ error: 'missing login' });
  const snap = req.body;
  if (!snap || typeof snap !== 'object') return res.status(400).json({ error: 'bad body' });
  store.set(login, snap);
  res.json({ ok: true, login });
});

// Bulk push (optional): overlay can send { players: { login: snapshot, ... } }.
app.post('/players', (req, res) => {
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!OVERLAY_SECRET || auth !== OVERLAY_SECRET) {
    return res.status(401).json({ error: 'bad overlay secret' });
  }
  const players = req.body && req.body.players;
  if (!players || typeof players !== 'object') return res.status(400).json({ error: 'missing players' });
  let n = 0;
  for (const [login, snap] of Object.entries(players)) {
    if (snap && typeof snap === 'object') { store.set(login, snap); n++; }
  }
  res.json({ ok: true, saved: n });
});

// ── READ: the panel asks "what do I own?" ────────────────────────────────────
// Header:  Authorization: Bearer <twitch JWT from Twitch.ext.onAuthorized>
app.get('/me', async (req, res) => {
  try {
    let login = null;

    // Dev/local preview path (never in production): /me?login=grom
    if (DEV_LOGIN_QUERY && req.query.login) {
      login = String(req.query.login).toLowerCase();
    } else {
      const claims = twitch.verifyPanelToken(req.get('authorization'));
      if (!claims.user_id) {
        // Viewer hasn't shared identity yet — panel shows a "link me" prompt.
        return res.json({ ok: true, state: 'needs_identity' });
      }
      login = await twitch.loginForUserId(claims.user_id);
      if (!login) return res.json({ ok: true, state: 'no_login' });
    }

    const snap = store.get(login);
    if (!snap) {
      return res.json({ ok: true, state: 'no_character', login });
    }
    res.json({ ok: true, state: 'ok', login, player: snap });
  } catch (e) {
    console.error('[/me]', e.message);
    res.status(401).json({ ok: false, error: e.message });
  }
});

// ── ACTION (Phase 2): panel asks to equip / lock one of the viewer's OWN items ──
// Auth: the viewer's Twitch JWT — the login is derived from the token, so a
// viewer can only ever act on their own stash, never someone else's.
//   body: { type:'equip'|'lock', index:1..N, name?:string, want?:boolean }
app.post('/action', async (req, res) => {
  try {
    let login = null;
    if (DEV_LOGIN_QUERY && req.query.login) {
      login = String(req.query.login).toLowerCase();
    } else {
      const claims = twitch.verifyPanelToken(req.get('authorization'));
      if (!claims.user_id) return res.json({ ok: true, state: 'needs_identity' });
      login = await twitch.loginForUserId(claims.user_id);
      if (!login) return res.json({ ok: true, state: 'no_login' });
    }
    const b = req.body || {};
    const type = String(b.type || '');
    if (type !== 'equip' && type !== 'lock' && type !== 'upgrade' && type !== 'battle') return res.status(400).json({ ok: false, error: 'bad type' });
    const action = { login, type };
    if (type === 'battle') {
      // queue a fight — tier picks the difficulty (viewer only ever fights as themselves)
      const tier = String(b.tier || 'battle').toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
      action.tier = ['battle', 'lt', 'boss', 'nightmare'].indexOf(tier) >= 0 ? tier : 'battle';
    } else if (type === 'upgrade') {
      // enhance an equipped slot — identified by its slot key/abbr, not a stash index
      const slot = String(b.slot || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 10);
      if (!slot) return res.status(400).json({ ok: false, error: 'bad slot' });
      action.slot = slot;
    } else {
      const index = parseInt(b.index, 10);
      if (!(index >= 1 && index <= 50)) return res.status(400).json({ ok: false, error: 'bad index' });
      action.index = index;
      action.name = b.name ? String(b.name).slice(0, 80) : null;
      if (type === 'lock') action.want = (typeof b.want === 'boolean') ? b.want : null;
    }
    store.enqueueAction(action);
    res.json({ ok: true, queued: true });
  } catch (e) {
    console.error('[/action]', e.message);
    res.status(401).json({ ok: false, error: e.message });
  }
});

// ── ACTIONS drain: the overlay pulls & clears the pending action queue ────────
// Auth: OVERLAY_SECRET (same trust as the write side).
app.get('/actions', (req, res) => {
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!OVERLAY_SECRET || auth !== OVERLAY_SECRET) return res.status(401).json({ error: 'nope' });
  res.json({ ok: true, actions: store.drainActions() });
});

// ── ADMIN: wipe every player snapshot (season reset) ─────────────────────────
// Auth: OVERLAY_SECRET (same trust as the write side). The overlay's !pitreset
// calls this after clearing its own save, so panels show empty for everyone.
app.post('/admin/clear', (req, res) => {
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!OVERLAY_SECRET || auth !== OVERLAY_SECRET) return res.status(401).json({ error: 'nope' });
  const cleared = store.clear();
  console.log(`[admin] season reset — cleared ${cleared} players`);
  res.json({ ok: true, cleared });
});

// Debug read (guarded by overlay secret) — handy while wiring things up.
app.get('/players/:login', (req, res) => {
  const auth = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!OVERLAY_SECRET || auth !== OVERLAY_SECRET) return res.status(401).json({ error: 'nope' });
  res.json(store.get(req.params.login) || { state: 'no_character' });
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`[pit-arena-ebs] listening on :${PORT}`);
  console.log(`  overlay write : POST /players/:login   (Bearer OVERLAY_SECRET)`);
  console.log(`  panel read    : GET  /me                (Bearer twitch JWT)`);
  console.log(`  panel action  : POST /action           (Bearer twitch JWT)`);
  console.log(`  overlay drain : GET  /actions           (Bearer OVERLAY_SECRET)`);
  console.log(`  twitch secret configured: ${twitch.hasSecret}`);
});

// Flush the store on shutdown so no in-flight writes are lost.
function shutdown() { store.flush(); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
