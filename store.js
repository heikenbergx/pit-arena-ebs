'use strict';
/**
 * store.js — snapshots and pending actions, namespaced per channel.
 *
 * ⚠ THE ONE CHANGE THAT MATTERS vs the single-tenant server: every key is scoped by
 * channel id. Two streamers can both have a viewer called "bob" and they are different
 * characters in different worlds. Nothing is global any more.
 *
 * Storage is in-memory with an optional JSON file behind it, same as v1 — deliberately.
 * Snapshots are disposable: the app re-posts everything whenever a fingerprint changes, so
 * losing the file costs one re-post per fighter, not real data. Swap in Redis/SQLite only
 * when a single process stops being enough.
 */
const fs = require('fs');
const path = require('path');

const FILE = process.env.STORE_FILE || path.join(__dirname, 'data', 'snapshots.json');
const MAX_ACTIONS_PER_CHANNEL = 200;

// channelId -> Map<login, snapshot>
const players = new Map();
// channelId -> array of pending actions
const actions = new Map();
// channelId -> last write timestamp (for /health and idle cleanup)
const seen = new Map();

let dirty = false;

function chan(map, channelId) {
  const k = String(channelId);
  if (!map.has(k)) map.set(k, map === players ? new Map() : []);
  return map.get(k);
}

function init() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [cid, obj] of Object.entries(raw.players || {})) {
      players.set(cid, new Map(Object.entries(obj)));
    }
    for (const [cid, ts] of Object.entries(raw.seen || {})) seen.set(cid, ts);
    console.log(`[store] loaded ${players.size} channel(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[store] load failed:', e.message);
  }
  // Actions are deliberately NOT persisted: a queued tap should not survive a restart and
  // fire minutes later against a changed game state.
  setInterval(flush, 10000);
}

function flush() {
  if (!dirty) return;
  dirty = false;
  const out = { players: {}, seen: {} };
  for (const [cid, m] of players) out.players[cid] = Object.fromEntries(m);
  for (const [cid, ts] of seen) out.seen[cid] = ts;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(out));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.warn('[store] save failed:', e.message);
  }
}

function put(channelId, login, snapshot) {
  chan(players, channelId).set(String(login).toLowerCase(), snapshot);
  seen.set(String(channelId), Date.now());
  dirty = true;
}

function get(channelId, login) {
  const m = players.get(String(channelId));
  return m ? m.get(String(login).toLowerCase()) || null : null;
}

function clearChannel(channelId) {
  const m = players.get(String(channelId));
  const n = m ? m.size : 0;
  players.delete(String(channelId));
  actions.delete(String(channelId));
  // ⚠ `seen` is deliberately KEPT. A season reset empties the roster; it does not mean the
  // channel stopped running the arena, and dropping it here would flip every viewer's panel
  // to "this channel isn't running the arena" until the app's next post.
  dirty = true;
  return n;
}

function countChannel(channelId) {
  const m = players.get(String(channelId));
  return m ? m.size : 0;
}

/**
 * Has this channel's app EVER posted here?
 *
 * ⚠ THIS IS WHAT SEPARATES THE PANEL'S TWO "NOTHING" STATES. A viewer on a channel that has
 * never run the arena must not be told to type !battle in chat — that advice can never work
 * and makes the extension look broken. `seen` is stamped on every write, so a channel becomes
 * known the first time its app posts a single fighter and stays known across restarts (it is
 * persisted with the snapshots). Worst case after a lost store file: one stream's viewers see
 * the "not set up" message until the app's first post, seconds later.
 */
function channelKnown(channelId) {
  const k = String(channelId || '');
  if (!k) return false;
  return seen.has(k) || players.has(k);
}

function lastSeen(channelId) {
  return seen.get(String(channelId || '')) || 0;
}

function pushAction(channelId, action) {
  const q = chan(actions, channelId);
  // Bound the queue: an app that is offline must not let taps pile up without limit.
  if (q.length >= MAX_ACTIONS_PER_CHANNEL) return false;
  q.push(action);
  return true;
}

function drainActions(channelId) {
  const k = String(channelId);
  const q = actions.get(k) || [];
  actions.set(k, []);
  return q;
}

function stats() {
  let fighters = 0;
  for (const m of players.values()) fighters += m.size;
  return { channels: players.size, fighters };
}

module.exports = {
  init, flush, put, get, clearChannel, countChannel,
  channelKnown, lastSeen, pushAction, drainActions, stats
};
