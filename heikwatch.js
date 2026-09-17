// =============================================================
//  heikwatch.js  -  username watcher for pit-arena-ebs
//
//  Watches the account currently holding a Twitch username.
//  When that account disappears (renamed, deleted, or reclaimed
//  by Twitch), it pings Discord.
//
//  Everything in here is wrapped in try/catch. If this file
//  fails for any reason it logs and moves on - it can never
//  take down the extension panel.
//
//  Set these in Render -> Environment:
//    WATCH_USERNAME        (optional, defaults to "heik")
//    WATCH_DISCORD_WEBHOOK (the webhook URL)
//    WATCH_DISCORD_USER_ID (your Discord user ID, numbers only)
// =============================================================

const GQL_URL = "https://gql.twitch.tv/gql";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // Twitch public web client ID

const USERNAME = (process.env.WATCH_USERNAME || "heik").toLowerCase().trim();
const WEBHOOK = (process.env.WATCH_DISCORD_WEBHOOK || "").trim();
const DISCORD_USER_ID = (process.env.WATCH_DISCORD_USER_ID || "").trim();

const CHECK_EVERY_MS = 15 * 60 * 1000;   // 15 minutes
const REMIND_EVERY_MS = 30 * 60 * 1000;  // re-alert at most this often
const CONFIRM_BEFORE_ALERT = 2;          // checks in a row that must agree
const FIRST_CHECK_DELAY_MS = 30 * 1000;  // let the server finish booting

const state = {
  username: USERNAME,
  startedAt: new Date().toISOString(),
  lastCheckAt: null,
  lastResult: "not yet checked",
  holderId: null,
  holderName: null,
  holderCreatedAt: null,
  goneStreak: 0,
  lastAlertAt: 0,
  alerted: false,
  checks: 0,
  errors: 0,
  lastError: null,
  selfTest: "not yet run",
};

function log(msg) {
  console.log("[heikwatch] " + msg);
}

async function gql(query) {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "Client-Id": GQL_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error("Twitch answered HTTP " + res.status);
  const json = await res.json();
  if (json && json.errors) {
    throw new Error("Twitch error: " + JSON.stringify(json.errors).slice(0, 200));
  }
  return json;
}

// Returns an account object, or null if nobody holds the name.
// Throws if we genuinely could not tell.
async function lookupAccount(name) {
  const query =
    'query{user(login:"' + name + '"){id login displayName createdAt}}';
  const json = await gql(query);
  return json.data.user; // null when the name is unheld
}

async function inspectAccount(name) {
  const query =
    'query{user(login:"' + name + '")' +
    "{id login displayName createdAt " +
    "roles{isPartner isAffiliate} " +
    "followers{totalCount} " +
    "lastBroadcast{startedAt}}}";
  try {
    const json = await gql(query);
    return json.data.user;
  } catch (err) {
    return null;
  }
}

async function sendDiscord(message, ping) {
  if (!WEBHOOK) return;
  let content = message;
  let allowed = { parse: [] };
  if (ping && /^\d+$/.test(DISCORD_USER_ID)) {
    content = "<@" + DISCORD_USER_ID + "> " + message;
    allowed = { users: [DISCORD_USER_ID] };
  }
  try {
    await fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: allowed }),
    });
  } catch (err) {
    log("could not send Discord message: " + err.message);
  }
}

// Proves we are really reading Twitch, so a silent API change
// can't look like "name still taken" forever.
async function selfTest() {
  try {
    const real = await lookupAccount("twitch");
    const nonsense =
      "zq" + Math.random().toString(36).slice(2, 14).replace(/[^a-z]/g, "a");
    const fake = await lookupAccount(nonsense);
    if (real && real.id && fake === null) {
      state.selfTest = "passed";
      log("self-test passed");
      return true;
    }
    state.selfTest = "FAILED";
    log("SELF-TEST FAILED - Twitch may have changed how this works");
    await sendDiscord(
      "Warning: the username watcher's self-test failed on pit-arena-ebs. " +
        "It may not be checking correctly anymore.",
      false
    );
    return false;
  } catch (err) {
    state.selfTest = "could not run: " + err.message;
    log("self-test could not run: " + err.message);
    return false;
  }
}

async function runCheck() {
  state.checks += 1;
  state.lastCheckAt = new Date().toISOString();

  let account;
  try {
    account = await lookupAccount(USERNAME);
  } catch (err) {
    state.errors += 1;
    state.lastError = err.message;
    state.lastResult = "error";
    log("check failed: " + err.message);
    return;
  }

  if (account === null) {
    state.goneStreak += 1;
    state.lastResult = "no account on the name (" + state.goneStreak + " in a row)";
    log(state.lastResult);

    const now = Date.now();
    const dueAgain = now - state.lastAlertAt > REMIND_EVERY_MS;
    if (state.goneStreak >= CONFIRM_BEFORE_ALERT && (!state.alerted || dueAgain)) {
      log("*** the account holding '" + USERNAME + "' is gone ***");
      await sendDiscord(
        "The account holding **" +
          USERNAME +
          "** is gone.\n" +
          "It is not claimable yet - Twitch holds a released name for around " +
          "6 months, and reclaimed names come back in unannounced batches.\n" +
          "Start checking by hand at https://www.twitch.tv/settings/profile",
        true
      );
      state.lastAlertAt = now;
      state.alerted = true;
    }
    return;
  }

  state.goneStreak = 0;
  const id = String(account.id);

  if (state.holderId && id !== state.holderId) {
    log("*** '" + USERNAME + "' changed hands ***");
    await sendDiscord(
      "Heads up: **" +
        USERNAME +
        "** changed hands. It is now held by '" +
        account.displayName +
        "' (id " +
        id +
        ").",
      true
    );
    state.alerted = false;
  }

  state.holderId = id;
  state.holderName = account.displayName;
  state.holderCreatedAt = account.createdAt;
  state.lastResult = "still held by " + account.displayName + " (id " + id + ")";
}

// Never let anything in here escape and disturb the main app.
async function safeRunCheck() {
  try {
    await runCheck();
  } catch (err) {
    state.errors += 1;
    state.lastError = err.message;
    log("unexpected problem, ignoring: " + err.message);
  }
}

function mountHeikWatch(app) {
  try {
    if (typeof fetch !== "function") {
      log("this Node version has no global fetch - watcher not started");
      return;
    }

    app.get("/heikwatch", (req, res) => res.json(state));

    app.get("/heikwatch/health", (req, res) => {
      res.json({
        ok: state.selfTest === "passed" && state.lastResult !== "error",
        watching: USERNAME,
        discordConfigured: Boolean(WEBHOOK),
        pingConfigured: /^\d+$/.test(DISCORD_USER_ID),
        selfTest: state.selfTest,
        lastCheckAt: state.lastCheckAt,
        lastResult: state.lastResult,
        checks: state.checks,
        errors: state.errors,
        lastError: state.lastError,
      });
    });

    app.get("/heikwatch/report", async (req, res) => {
      const details = await inspectAccount(USERNAME);
      if (!details) return res.json({ username: USERNAME, holder: null });
      const roles = details.roles || {};
      res.json({
        username: USERNAME,
        displayName: details.displayName,
        id: details.id,
        createdAt: details.createdAt,
        isPartner: Boolean(roles.isPartner),
        isAffiliate: Boolean(roles.isAffiliate),
        followers: details.followers ? details.followers.totalCount : null,
        lastBroadcast: details.lastBroadcast
          ? details.lastBroadcast.startedAt
          : "never streamed",
        reclaimEligible: !roles.isPartner,
      });
    });

    setTimeout(async () => {
      await selfTest();
      await safeRunCheck();
      await sendDiscord(
        "Username watcher is running on pit-arena-ebs, watching **" +
          USERNAME +
          "**. Currently: " +
          state.lastResult,
        false
      );
    }, FIRST_CHECK_DELAY_MS);

    setInterval(safeRunCheck, CHECK_EVERY_MS);

    log("mounted - watching '" + USERNAME + "' every 15 minutes");
  } catch (err) {
    log("failed to start, panel is unaffected: " + err.message);
  }
}

module.exports = mountHeikWatch;
