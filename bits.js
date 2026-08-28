/* =================================================================
   bits.js — drop-in bits leaderboard poller

   Mounts two routes onto an existing Express app:

     GET /bits          bits totals, read by the overlay
     GET /bits/health   whether the poller is configured and working

   Add to your server with two lines:

     const { mountBits } = require('./bits');
     mountBits(app);

   Environment variables (all prefixed BITS_ so they can't collide
   with the extension's EXT_ credentials):

     BITS_CLIENT_ID
     BITS_CLIENT_SECRET
     BITS_REFRESH_TOKEN
     BITS_POLL_SECONDS      optional, defaults to 20

   Reads two leaderboards each pass:

     totalBits   period=all  — every bit the channel ever took
     dayBits     period=day  — bits taken today, resets midnight PT

   The all-time board is capped at the top 100 cheerers of all time,
   which a long-running channel fills up, so anyone outside that
   hundred is invisible in it. Today's board only ranks people who
   cheered today, so it is almost never full and misses nobody. The
   overlay uses the day figure for a session bar and the all-time
   figure for periods that span more than one day.
   ================================================================= */

const CLIENT_ID = process.env.BITS_CLIENT_ID;
const CLIENT_SECRET = process.env.BITS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.BITS_REFRESH_TOKEN;
const POLL_MS = Number(process.env.BITS_POLL_SECONDS || 20) * 1000;

let accessToken = null;
let cache = {
  totalBits: null,
  dayBits: null,
  leaders: 0,
  dayLeaders: 0,
  updatedAt: null,
  error: null,
};
let timer = null;

async function refreshAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  accessToken = data.access_token;
  console.log('[bits] access token refreshed');
  return accessToken;
}

async function fetchLeaderboard(period, retrying = false) {
  if (!accessToken) await refreshAccessToken();

  // Twitch rejects any period other than "all" unless started_at is
  // supplied. Sending the current instant is enough — Twitch snaps it
  // to whichever period contains it, so this always means "today".
  // Fractional seconds are not accepted, hence the trim.
  let url = `https://api.twitch.tv/helix/bits/leaderboard?count=100&period=${period}`;
  if (period !== 'all') {
    const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    url += `&started_at=${encodeURIComponent(startedAt)}`;
  }

  // The broadcaster comes from the token, so no broadcaster id needed.
  const res = await fetch(url, {
    headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401 && !retrying) {
    await refreshAccessToken();
    return fetchLeaderboard(period, true);
  }

  if (!res.ok) throw new Error(`leaderboard ${period} ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rows = data.data || [];

  return {
    bits: rows.reduce((sum, row) => sum + (row.score || 0), 0),
    leaders: rows.length,
  };
}

async function poll() {
  try {
    const [all, day] = await Promise.all([
      fetchLeaderboard('all'),
      fetchLeaderboard('day'),
    ]);

    // The all-time total should only ever climb. A drop means a
    // partial or cached response, and passing it on would make the
    // overlay think bits had been refunded.
    if (cache.totalBits !== null && all.bits < cache.totalBits) {
      console.warn(`[bits] ignoring all-time drop ${cache.totalBits} -> ${all.bits}`);
      return;
    }

    // The day figure legitimately falls to zero at midnight Pacific,
    // so it gets no such guard.
    cache = {
      totalBits: all.bits,
      dayBits: day.bits,
      leaders: all.leaders,
      dayLeaders: day.leaders,
      updatedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    console.error('[bits]', err.message);
    cache.error = err.message;
  }
}

function mountBits(app) {
  // The overlay runs on streamelements.com, so these routes set their
  // own CORS header rather than relying on ALLOWED_ORIGINS. Nothing
  // returned here is sensitive.
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store');
    next();
  };

  const missing = ['BITS_CLIENT_ID', 'BITS_CLIENT_SECRET', 'BITS_REFRESH_TOKEN']
    .filter((k) => !process.env[k]);

  // Routes are registered either way. A missing config should say so
  // out loud rather than produce a mystery 404.
  app.get('/bits', cors, (req, res) => {
    if (missing.length) {
      return res.status(503).json({
        error: 'bits poller not configured',
        missingEnvVars: missing,
        hint: 'Add these in the Render Environment tab, then redeploy.',
      });
    }
    if (cache.totalBits === null) {
      return res.status(503).json({ error: cache.error || 'no reading yet, try again in a few seconds' });
    }
    res.json({
      totalBits: cache.totalBits,
      dayBits: cache.dayBits,
      leaders: cache.leaders,
      dayLeaders: cache.dayLeaders,
      updatedAt: cache.updatedAt,
      stale: cache.error !== null,
    });
  });

  app.get('/bits/health', cors, (req, res) => {
    res.json({
      ok: cache.totalBits !== null,
      configured: missing.length === 0,
      missingEnvVars: missing,
      totalBits: cache.totalBits,
      dayBits: cache.dayBits,
      leaders: cache.leaders,
      dayLeaders: cache.dayLeaders,
      updatedAt: cache.updatedAt,
      error: cache.error,
    });
  });

  if (missing.length) {
    console.warn(`[bits] NOT POLLING — missing env vars: ${missing.join(', ')}`);
    console.warn('[bits] /bits will return a 503 explaining this until they are set.');
    return;
  }

  poll();
  timer = setInterval(poll, POLL_MS);
  console.log(`[bits] polling every ${POLL_MS / 1000}s (all-time + today)`);
}

function stopBits() {
  if (timer) clearInterval(timer);
}

module.exports = { mountBits, stopBits };
