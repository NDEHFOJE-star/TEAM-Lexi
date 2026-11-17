// =====================================================================
// LEXI - server.js
//
//   1. Settings        secrets, time limits
//   2. Database        Turso (or a local file when testing on your PC)
//   3. Safety tools    rate limiter, security headers, CSRF check
//   4. Sessions        sign in cookie that refreshes while you are active
//   5. Routes          accounts, passages, synced data, sharing
//   6. Start
// =====================================================================
"use strict";

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createClient } = require("@libsql/client");

const IS_PROD = process.env.NODE_ENV === "production";
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// 1. SETTINGS
// ---------------------------------------------------------------------
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Without a fixed secret everybody is signed out each time the server restarts.
  JWT_SECRET = crypto.randomBytes(48).toString("hex");
  console.warn("WARNING: JWT_SECRET is not set. Set it in your environment variables.");
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const IDLE_SHORT = 2 * 60 * MINUTE;   // not "stay signed in": signed out after 2 hours without use
const IDLE_LONG = 30 * DAY;           // "stay signed in": signed out after 30 days without use
const ABSOLUTE_MAX = 90 * DAY;        // nobody stays signed in longer than this, even if active
const REFRESH_AFTER = 5 * 60;         // seconds: renew the cookie if it is older than this

const DATA_KEYS = ["settings", "stats", "words", "reads", "calib"];
const MAX_PASSAGES_PER_USER = 100;
const COMMON_PASSWORDS = [
  "password", "password1", "12345678", "123456789", "qwertyui", "qwerty123",
  "iloveyou", "11111111", "abcd1234", "letmein123"
];

// ---------------------------------------------------------------------
// 2. DATABASE
// ---------------------------------------------------------------------
const DB_URL = process.env.TURSO_DATABASE_URL || "file:" + path.join(__dirname, "lexi.db");
if (!process.env.TURSO_DATABASE_URL) {
  console.warn("NOTE: TURSO_DATABASE_URL is not set, using the local file lexi.db. " +
    "On Render this file is erased now and then, so set the Turso variables.");
}
const db = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN });

// Run a query and always get back a list of plain objects
async function query(sql, args) {
  const result = await db.execute({ sql: sql, args: args || [] });
  return result.rows.map(function (row) {
    const plain = {};
    result.columns.forEach(function (column) { plain[column] = row[column]; });
    return plain;
  });
}

async function run(sql, args) {
  const result = await db.execute({ sql: sql, args: args || [] });
  return { changes: Number(result.rowsAffected || 0), lastId: Number(result.lastInsertRowid || 0) };
}

async function initDatabase() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       name          TEXT NOT NULL,
       email         TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       share_code    TEXT UNIQUE,
       created_at    TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS passages (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id    INTEGER,
       title      TEXT NOT NULL,
       text       TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS user_data (
       user_id    INTEGER NOT NULL,
       key        TEXT NOT NULL,
       value      TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       PRIMARY KEY (user_id, key)
     )`
  ], "write");

  // An older Lexi database has passages without a user_id column: add it.
  const columns = await query("PRAGMA table_info(passages)");
  if (!columns.some(function (c) { return c.name === "user_id"; })) {
    await run("ALTER TABLE passages ADD COLUMN user_id INTEGER");
  }
  await run("CREATE INDEX IF NOT EXISTS idx_passages_user ON passages (user_id, id)");
}

// ---------------------------------------------------------------------
// 3. SAFETY TOOLS
// ---------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1); // Render sits in front of the app: believe its X-Forwarded headers
app.disable("x-powered-by");

// Rate limiter: "this key may try max times per windowMs"
const attempts = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
function forgive(key) { attempts.delete(key); }
setInterval(function () {
  const now = Date.now();
  attempts.forEach(function (entry, key) { if (entry.reset < now) attempts.delete(key); });
}, 10 * MINUTE).unref();

// Security headers
app.use(function (req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(express.json({ limit: "300kb" }));
app.use(cookieParser());

// CSRF defence: every change to the data must carry our own header. A web page on
// another site cannot add this header to a request to us.
app.use("/api", function (req, res, next) {
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe && req.headers["x-lexi"] !== "1") {
    return res.status(403).json({ error: "Request blocked." });
  }
  next();
});

// Express 4 does not catch errors in async routes by itself: this wrapper does.
function wrap(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------
// 4. SESSIONS (a signed token stored in an HttpOnly cookie)
// ---------------------------------------------------------------------
const COOKIE = "lexi_session";
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function setSession(res, userId, remember, startedAt) {
  const lifeMs = remember ? IDLE_LONG : IDLE_SHORT;
  const token = jwt.sign(
    { uid: userId, rem: remember ? 1 : 0, st: startedAt },
    JWT_SECRET,
    { expiresIn: Math.floor(lifeMs / 1000) }
  );
  const options = { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" };
  if (remember) options.maxAge = lifeMs; // otherwise it is a "browser session" cookie
  res.cookie(COOKIE, token, options);
}

function clearSession(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: IS_PROD, path: "/" });
}

// Put this in front of every route that needs a signed-in user
const requireAuth = wrap(async function (req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: "Please sign in.", code: "none" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    clearSession(res);
    const expired = e && e.name === "TokenExpiredError";
    return res.status(401).json({
      error: expired ? "You were signed out because you were away for a while." : "Please sign in again.",
      code: expired ? "expired" : "none"
    });
  }

  if (Date.now() - payload.st > ABSOLUTE_MAX) {
    clearSession(res);
    return res.status(401).json({ error: "Please sign in again.", code: "expired" });
  }

  const rows = await query("SELECT id, name, email FROM users WHERE id = ?", [payload.uid]);
  if (rows.length === 0) {
    clearSession(res);
    return res.status(401).json({ error: "Please sign in again.", code: "none" });
  }

  // Sliding session: while you keep using Lexi the cookie is renewed.
  if (Math.floor(Date.now() / 1000) - payload.iat > REFRESH_AFTER) {
    setSession(res, payload.uid, payload.rem === 1, payload.st);
  }

  req.user = { id: rows[0].id, name: rows[0].name, email: rows[0].email, remember: payload.rem === 1 };
  next();
});

// ---------------------------------------------------------------------
// 5. ROUTES
// ---------------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user, remember) {
  return {
    user: { id: user.id, name: user.name, email: user.email },
    remember: !!remember,
    idleMinutes: Math.round((remember ? IDLE_LONG : IDLE_SHORT) / MINUTE)
  };
}

app.get("/api/health", function (req, res) { res.json({ ok: true }); });

// ----- accounts -----
app.post("/api/auth/register", wrap(async function (req, res) {
  if (tooMany("reg|" + req.ip, 10, 60 * MINUTE)) {
    return res.status(429).json({ error: "Too many sign-up attempts. Please try again later." });
  }
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: "Your password must have at least 8 characters." });
  }
  if (COMMON_PASSWORDS.includes(password.toLowerCase())) {
    return res.status(400).json({ error: "That password is too common. Please choose another one." });
  }

  const existing = await query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length > 0) {
    return res.status(409).json({ error: "An account with that email already exists. Try signing in." });
  }

  const hash = await bcrypt.hash(password, 10);
  const created = await run("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)", [name, email, hash]);

  const remember = body.remember === true;
  setSession(res, created.lastId, remember, Date.now());
  res.status(201).json(publicUser({ id: created.lastId, name: name, email: email }, remember));
}));

app.post("/api/auth/login", wrap(async function (req, res) {
  const body = req.body || {};
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const key = "login|" + req.ip + "|" + email;

  if (tooMany(key, 8, 15 * MINUTE)) {
    return res.status(429).json({ error: "Too many attempts. Please wait 15 minutes and try again." });
  }

  const rows = await query("SELECT id, name, email, password_hash FROM users WHERE email = ?", [email]);
  const user = rows[0];
  // Always compare against a hash, even for unknown emails, so timing does not reveal who has an account.
  const good = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !good) {
    return res.status(401).json({ error: "Incorrect email or password.", code: "bad" });
  }

  forgive(key);
  const remember = body.remember === true;
  setSession(res, user.id, remember, Date.now());
  res.json(publicUser(user, remember));
}));

app.post("/api/auth/logout", function (req, res) {
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, function (req, res) {
  res.json(publicUser(req.user, req.user.remember));
});

// The page calls this now and then while you are active, to keep you signed in.
app.post("/api/auth/ping", requireAuth, function (req, res) {
  res.json({ ok: true });
});

// ----- passages (each user only ever sees their own) -----
function cleanPassageInput(body) {
  const text = body && typeof body.text === "string" ? body.text.trim() : "";
  const title = body && typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  return { text: text, title: title };
}

app.get("/api/passages", requireAuth, wrap(async function (req, res) {
  const rows = await query(
    "SELECT id, title, text, created_at FROM passages WHERE user_id = ? ORDER BY id DESC",
    [req.user.id]
  );
  res.json(rows);
}));

app.post("/api/passages", requireAuth, wrap(async function (req, res) {
  const input = cleanPassageInput(req.body);
  if (!input.text || input.text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }
  const created = await run(
    "INSERT INTO passages (user_id, title, text) VALUES (?, ?, ?)",
    [req.user.id, input.title || "Untitled", input.text]
  );
  await run(
    "DELETE FROM passages WHERE user_id = ? AND id NOT IN " +
    "(SELECT id FROM passages WHERE user_id = ? ORDER BY id DESC LIMIT " + MAX_PASSAGES_PER_USER + ")",
    [req.user.id, req.user.id]
  );
  const rows = await query("SELECT id, title, text, created_at FROM passages WHERE id = ?", [created.lastId]);
  res.status(201).json(rows[0]);
}));

app.put("/api/passages/:id", requireAuth, wrap(async function (req, res) {
  const id = Number(req.params.id);
  const input = cleanPassageInput(req.body);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid passage id" });
  if (!input.text || input.text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }
  const result = await run(
    "UPDATE passages SET text = ?, title = COALESCE(NULLIF(?, ''), title) WHERE id = ? AND user_id = ?",
    [input.text, input.title, id, req.user.id]
  );
  if (result.changes === 0) return res.status(404).json({ error: "Passage not found" });
  const rows = await query("SELECT id, title, text, created_at FROM passages WHERE id = ?", [id]);
  res.json(rows[0]);
}));

app.delete("/api/passages/:id", requireAuth, wrap(async function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid passage id" });
  const result = await run("DELETE FROM passages WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (result.changes === 0) return res.status(404).json({ error: "Passage not found" });
  res.json({ deleted: id });
}));

// ----- synced data: settings, reading stats, practice words, reading checks -----
app.get("/api/data", requireAuth, wrap(async function (req, res) {
  const rows = await query("SELECT key, value FROM user_data WHERE user_id = ?", [req.user.id]);
  const data = {};
  rows.forEach(function (row) {
    try { data[row.key] = JSON.parse(row.value); } catch (e) { /* skip a damaged entry */ }
  });
  res.json({ data: data });
}));

app.put("/api/data/:key", requireAuth, wrap(async function (req, res) {
  const key = req.params.key;
  if (!DATA_KEYS.includes(key)) return res.status(400).json({ error: "Unknown data key" });
  if (!req.body || req.body.value === undefined) return res.status(400).json({ error: "Missing value" });
  const text = JSON.stringify(req.body.value);
  if (text.length > 200000) return res.status(413).json({ error: "Data is too large" });
  await run(
    "INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) " +
    "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    [req.user.id, key, text]
  );
  res.json({ ok: true });
}));

// ----- sharing progress with a teacher or parent (read only) -----
const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";
function makeShareCode() {
  const bytes = crypto.randomBytes(10);
  let code = "";
  for (let i = 0; i < bytes.length; i++) code += CODE_LETTERS[bytes[i] % CODE_LETTERS.length];
  return code;
}

app.get("/api/share", requireAuth, wrap(async function (req, res) {
  const rows = await query("SELECT share_code FROM users WHERE id = ?", [req.user.id]);
  res.json({ code: rows[0] ? rows[0].share_code : null });
}));

app.post("/api/share", requireAuth, wrap(async function (req, res) {
  const code = makeShareCode(); // a new code each time, so the old link stops working
  await run("UPDATE users SET share_code = ? WHERE id = ?", [code, req.user.id]);
  res.status(201).json({ code: code });
}));

app.delete("/api/share", requireAuth, wrap(async function (req, res) {
  await run("UPDATE users SET share_code = NULL WHERE id = ?", [req.user.id]);
  res.json({ code: null });
}));

// Anyone with the code can see this report. It has no email and no passage text.
app.get("/api/shared/:code", wrap(async function (req, res) {
  if (tooMany("share|" + req.ip, 60, 15 * MINUTE)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  const code = String(req.params.code || "");
  if (!/^[a-z0-9]{6,20}$/.test(code)) return res.status(404).json({ error: "This link is not valid." });

  const users = await query("SELECT id, name FROM users WHERE share_code = ?", [code]);
  if (users.length === 0) return res.status(404).json({ error: "This link is not valid or sharing was turned off." });

  const rows = await query("SELECT key, value FROM user_data WHERE user_id = ?", [users[0].id]);
  const data = {};
  rows.forEach(function (row) {
    try { data[row.key] = JSON.parse(row.value); } catch (e) { /* skip */ }
  });

  // Only the numbers a teacher needs, nothing else
  const stats = data.stats || {};
  const days = {};
  Object.keys(stats.days || {}).sort().slice(-30).forEach(function (day) { days[day] = stats.days[day]; });

  const words = Object.keys(data.words || {}).map(function (word) {
    const entry = data.words[word] || {};
    return { word: word, count: entry.count || 0, box: entry.box || 1, ok: entry.ok || 0, bad: entry.bad || 0 };
  }).sort(function (a, b) { return a.box - b.box || b.count - a.count; }).slice(0, 40);

  res.json({
    name: String(users[0].name).split(" ")[0],
    stats: {
      totalSeconds: stats.totalSeconds || 0,
      totalWords: stats.totalWords || 0,
      completed: stats.completed || 0,
      days: days
    },
    words: words,
    reads: (Array.isArray(data.reads) ? data.reads.slice(-12) : []).map(function (r) {
      return { t: Number(r && r.t) || 0, wpm: Number(r && r.wpm) || 0, acc: Number(r && r.acc) || 0, words: Number(r && r.words) || 0 };
    }),
    calib: data.calib || null
  });
}));

// Anything else under /api is an unknown address
app.use("/api", function (req, res) {
  res.status(404).json({ error: "Not found" });
});

// ----- the website itself -----
app.use(express.static(path.join(__dirname, "lexi")));

// ----- errors -----
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Bad request" });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request too large" });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

// ---------------------------------------------------------------------
// 6. START
// ---------------------------------------------------------------------
initDatabase()
  .then(function () {
    app.listen(PORT, function () { console.log("Lexi is running on port " + PORT); });
  })
  .catch(function (err) {
    console.error("Could not start the database:", err);
    process.exit(1);
  });
