'use strict';
/**
 * twitch.js — everything that talks to Twitch.
 *
 *  1. verifyPanelToken(authHeader): checks the JWT the panel sends is genuinely
 *     signed by your extension secret, and returns its claims.
 *  2. loginForUserId(userId): turns a numeric Twitch user id (which the panel
 *     gives us AFTER the viewer links their identity) into their login name,
 *     using an app access token. Cached.
 *
 * Why we need the login: the overlay/game keys everyone by their chat username
 * (login). The panel only knows the viewer by numeric id. This bridges them.
 */
const jwt = require('jsonwebtoken');

const CLIENT_ID = process.env.EXT_CLIENT_ID || '';
const SECRET_B64 = process.env.EXT_SECRET || '';

// The extension secret is base64 in the dev console. jsonwebtoken needs the raw bytes.
const SECRET = SECRET_B64 ? Buffer.from(SECRET_B64, 'base64') : null;

function verifyPanelToken(authHeader) {
  if (!SECRET) throw new Error('EXT_SECRET not configured');
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) throw new Error('missing bearer token');
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  // Twitch signs extension JWTs with HS256 using your (base64-decoded) secret.
  const claims = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
  // claims of interest: { channel_id, user_id?, opaque_user_id, role, exp }
  // user_id is ONLY present once the viewer has shared/linked their identity.
  return claims;
}

// ── App access token (client-credentials) cache, for Helix id→login lookups ──
let appToken = null;
let appTokenExp = 0;

async function getAppToken() {
  const now = Date.now();
  if (appToken && now < appTokenExp - 60000) return appToken;
  if (!CLIENT_ID || !process.env.EXT_SECRET) {
    throw new Error('EXT_CLIENT_ID / client secret not configured for Helix lookup');
  }
  // NOTE: Twitch's OAuth client-credentials uses your extension's CLIENT ID and
  // its CLIENT SECRET. The extension "secret key" (EXT_SECRET) above is a
  // DIFFERENT thing (JWT signing). If you registered the extension you'll find
  // the client secret in the dev console next to the client id.
  const clientSecret = process.env.EXT_CLIENT_SECRET || '';
  if (!clientSecret) throw new Error('EXT_CLIENT_SECRET not set (needed to resolve viewer login)');
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: clientSecret,
    grant_type: 'client_credentials'
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body });
  if (!res.ok) throw new Error('token request failed: ' + res.status);
  const json = await res.json();
  appToken = json.access_token;
  appTokenExp = now + (json.expires_in || 3600) * 1000;
  return appToken;
}

const loginCache = new Map(); // userId -> { login, exp }

async function loginForUserId(userId) {
  if (!userId) return null;
  const hit = loginCache.get(userId);
  if (hit && Date.now() < hit.exp) return hit.login;
  const token = await getAppToken();
  const res = await fetch('https://api.twitch.tv/helix/users?id=' + encodeURIComponent(userId), {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('helix users failed: ' + res.status);
  const json = await res.json();
  const login = json.data && json.data[0] && json.data[0].login;
  if (login) loginCache.set(userId, { login, exp: Date.now() + 3600000 });
  return login || null;
}

module.exports = { verifyPanelToken, loginForUserId, CLIENT_ID, hasSecret: !!SECRET };
