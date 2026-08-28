/* =================================================================
   bits.js — drop-in bits leaderboard poller

   Mounts two routes onto an existing Express app:

     GET /bits    running channel bits total, read by the overlay
     GET /bits/health   whether the poller has a reading

   Add to your server with two lines:

     const { mountBits } = require('./bits');
     mountBits(app);

   Environment variables (all prefixed BITS_ so they can't collide
   with the extension's EXT_ credentials):

     BITS_CLIENT_ID
     BITS_CLIENT_SECRET
     BITS_REFRESH_TOKEN
     BITS_POLL_SECONDS      optional, defaults to 20

   If the variables are missing the module logs a warning and does
   nothing. It will never take the extension backend down with it.
   ================================================================= */

const CLIENT_ID = process.env.BITS_CLIENT_ID;
const CLIENT_SECRET = process.env.BITS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.BITS_REFRESH_TOKEN;
const POLL_MS = Number(process.env.BITS_POLL_SECONDS || 20) * 1000;

let accessToken = null;
let cache = { totalBits: null, leaders: 0, updatedAt: null, error: null };
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

async function fetchLeaderboard(retrying = false) {
  if (!accessToken) await refreshAccessToken();

  // period=all so the window never rolls over underneath the overlay.
  // The broadcaster is taken from the token, so no broadcaster id is
  // needed here.
  const res = await fetch(
    'https://api.twitch.tv/helix/bits/leaderboard?count=100&period=all',
    { headers: { 'Client-Id': CLIENT_ID, Authorization: `Bearer ${accessToken}` } }
  );

  if (res.status === 401 && !retrying) {
    await refreshAccessToken();
    return fetchLeaderboard(true);
  }

  if (!res.ok) throw new Error(`leaderboard ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const rows = data.data || [];

  // Caps at the top 100 cheerers, so on a very large channel this
  // total is a floor rather than an exact figure.
  return {
    totalBits: rows.reduce((sum, row) => sum + (row.score || 0), 0),
    leaders: rows.length,
  };
}

async function poll() {
  try {
    const { totalBits, leaders } = await fetchLeaderboard();

    // The total should only ever climb. A drop means a partial or
    // cached response, and passing it on would make the overlay think
    // bits had been refunded.
    if (cache.totalBits !== null && totalBits < cache.totalBits) {
      console.warn(`[bits] ignoring drop ${cache.totalBits} -> ${totalBits}`);
      return;
    }

    cache = { totalBits, leaders, updatedAt: new Date().toISOString(), error: null };
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
      leaders: cache.leaders,
      updatedAt: cache.updatedAt,
      stale: cache.error !== null,
    });
  });

  app.get('/bits/health', cors, (req, res) => {
    res.json({
      ok: cache.totalBits !== null,
      configured: missing.length === 0,
      missingEnvVars: missing,
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
  console.log(`[bits] polling every ${POLL_MS / 1000}s`);
}

function stopBits() {
  if (timer) clearInterval(timer);
}

module.exports = { mountBits, stopBits };
