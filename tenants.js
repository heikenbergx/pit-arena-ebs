'use strict';
/**
 * tenants.js — per-channel write keys, replacing the single shared OVERLAY_SECRET.
 *
 * THE PROBLEM THIS SOLVES
 * A shipped app cannot carry one shared secret: every copy would hold the key to post
 * snapshots for ANY channel. So each channel gets its own key, and the key itself names the
 * channel it is valid for.
 *
 * DESIGN: KEYS ARE DERIVED, NOT STORED.
 *   key = "<channelId>-<rev>-<hmac(MASTER_KEY_SECRET, channelId:rev)[0..24]>"
 * Verification recomputes the HMAC, so there is no key table to keep, back up, or leak. A
 * key is self-describing: parse the channel out of it, recompute, compare.
 *
 * ⚠ CONSEQUENCE: rotating MASTER_KEY_SECRET invalidates EVERY channel's key at once. Do not
 * change it casually. Per-channel revocation is the `rev` counter instead (bump one channel's
 * rev and only that channel re-copies its key).
 *
 * HOW A STREAMER GETS THEIR KEY
 * Through Twitch's own auth, never over chat or email. The extension's config view is opened
 * by the broadcaster while logged in to Twitch; its JWT carries role:'broadcaster' and their
 * channel_id, both signed by the extension secret. GET /config/key verifies that and returns
 * the derived key. So only the real channel owner can ever see their key, and the server does
 * not have to trust anything the client claims.
 *
 * ⚠⚠ REVS MUST SURVIVE A RESTART, AND THIS IS WHY.
 * The revocation counter is the ONLY piece of state in the whole scheme. An in-memory Map
 * looks harmless — until Render restarts on a deploy, `revs` comes back empty, every channel
 * silently drops back to rev 0, and A KEY THAT WAS REVOKED BECOMES VALID AGAIN. Revocation is
 * exactly the thing you reach for after leaking a key on stream, so "it works until the next
 * deploy" is the worst possible failure mode for it. Persisted to its own small JSON file,
 * written synchronously on every bump (bumps are rare — a handful ever, not per request).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MASTER = process.env.MASTER_KEY_SECRET || '';
const REV_FILE = process.env.REV_FILE ||
  path.join(path.dirname(process.env.STORE_FILE || path.join(__dirname, 'data', 'snapshots.json')), 'revs.json');

// channelId -> revocation counter. Only ever holds channels that revoked at least once; an
// empty map means "everyone is on rev 0".
const revs = new Map();

(function loadRevs() {
  try {
    const raw = JSON.parse(fs.readFileSync(REV_FILE, 'utf8'));
    for (const [cid, rev] of Object.entries(raw || {})) {
      const n = Number(rev);
      if (Number.isInteger(n) && n > 0) revs.set(String(cid), n);
    }
    if (revs.size) console.log(`[tenants] loaded revocations for ${revs.size} channel(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[tenants] could not read revs:', e.message);
  }
})();

function saveRevs() {
  try {
    fs.mkdirSync(path.dirname(REV_FILE), { recursive: true });
    fs.writeFileSync(REV_FILE + '.tmp', JSON.stringify(Object.fromEntries(revs)));
    fs.renameSync(REV_FILE + '.tmp', REV_FILE);
    return true;
  } catch (e) {
    // ⚠ Be LOUD. A bump that isn't persisted is a revocation that will undo itself, and the
    // streamer has already been told their old key is dead.
    console.error('[tenants] ⚠ COULD NOT PERSIST REVOCATION — it will be lost on restart:', e.message);
    return false;
  }
}

function hasMaster() { return !!MASTER; }

function revOf(channelId) { return revs.get(String(channelId)) || 0; }

function bumpRev(channelId) {
  const next = revOf(channelId) + 1;
  revs.set(String(channelId), next);
  const persisted = saveRevs();
  return { rev: next, persisted };
}

function sign(channelId, rev) {
  return crypto
    .createHmac('sha256', MASTER)
    .update(String(channelId) + ':' + rev)
    .digest('base64url')
    .slice(0, 24);
}

function keyFor(channelId) {
  if (!MASTER) throw new Error('MASTER_KEY_SECRET not configured');
  const rev = revOf(channelId);
  return `${channelId}-${rev}-${sign(channelId, rev)}`;
}

/**
 * Resolve a write key to its channel id, or null.
 * Constant-time compare so a wrong key leaks nothing through timing.
 */
function channelForKey(key) {
  if (!MASTER || !key) return null;
  const m = /^(\d+)-(\d+)-([A-Za-z0-9_-]{24})$/.exec(String(key).trim());
  if (!m) return null;
  const [, channelId, revStr, mac] = m;
  const rev = Number(revStr);
  // A key at a superseded rev is dead — that is what revocation means.
  if (rev !== revOf(channelId)) return null;
  const expected = sign(channelId, rev);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? channelId : null;
}

/** Express helper: pull the channel id out of the Authorization header. */
function channelFromAuth(authHeader) {
  const key = String(authHeader || '').replace(/^Bearer\s+/i, '').trim();
  return channelForKey(key);
}

/**
 * Does this look like an arena key at all (vs. a legacy overlay secret)? Used only to give a
 * better error message — never for authorisation.
 */
function looksLikeKey(key) {
  return /^\d+-\d+-[A-Za-z0-9_-]{24}$/.test(String(key || '').trim());
}

module.exports = {
  keyFor, channelForKey, channelFromAuth, bumpRev, revOf, hasMaster, looksLikeKey
};
