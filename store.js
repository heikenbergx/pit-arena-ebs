'use strict';
/**
 * store.js — the "shared memory".
 *
 * Dead-simple flat-file JSON store, keyed by lowercased Twitch login (which is
 * exactly how the overlay keys its characters). One object per player holding
 * the panel-ready snapshot the overlay pushes up.
 *
 * This is intentionally the smallest thing that works for launch. When traffic
 * grows or you move to an ephemeral host (no persistent disk), replace the guts
 * of this file with a real database (Postgres, Redis, Upstash, etc.) — the rest
 * of the server only uses get()/set()/all(), so nothing else has to change.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || './data/players.json';

let cache = {};       // login -> snapshot
let dirty = false;
let writeTimer = null;

// ── Panel action inbox (Phase 2) ─────────────────────────────────────────────
// Transient, in-memory queue of actions the panel asked for (equip / lock).
// The overlay drains it every couple seconds and runs each one. Not persisted:
// if the server restarts, a couple of in-flight taps are lost — harmless (the
// viewer just taps again). Capped so a spammer can't grow it without bound.
let actions = [];
const MAX_ACTIONS = 500;

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    cache = JSON.parse(raw) || {};
    console.log(`[store] loaded ${Object.keys(cache).length} players from ${DATA_FILE}`);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log(`[store] no data file yet at ${DATA_FILE} — starting empty`);
      cache = {};
    } else {
      console.error('[store] load failed, starting empty:', e.message);
      cache = {};
    }
  }
}

function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, DATA_FILE);   // atomic-ish swap so a crash can't truncate
  } catch (e) {
    console.error('[store] persist failed:', e.message);
    dirty = true; // try again next tick
  }
}

// Debounced write so a burst of updates only hits disk once.
function scheduleWrite() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; persist(); }, 1500);
}

const key = (login) => String(login || '').trim().toLowerCase();

module.exports = {
  init() { load(); },

  get(login) {
    return cache[key(login)] || null;
  },

  set(login, snapshot) {
    const k = key(login);
    if (!k) return;
    cache[k] = Object.assign({}, snapshot, { login: k, updatedAt: Date.now() });
    scheduleWrite();
  },

  all() { return cache; },

  count() { return Object.keys(cache).length; },

  // Wipe EVERY player snapshot (season reset). Returns how many were cleared.
  clear() {
    const n = Object.keys(cache).length;
    cache = {};
    actions = [];        // drop any pending panel taps too
    scheduleWrite();
    return n;
  },

  // ── action inbox ──
  enqueueAction(action) {
    if (actions.length >= MAX_ACTIONS) actions.shift();   // drop oldest under flood
    actions.push(Object.assign({ ts: Date.now() }, action));
  },
  drainActions() { const a = actions; actions = []; return a; },
  pendingActions() { return actions.length; },

  // Flush on shutdown so nothing in the debounce window is lost.
  flush() { persist(); }
};
