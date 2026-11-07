const express = require("express");
const cors = require("cors");
const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // SQLite is built into Node 22.5+

const app = express();
app.use(cors());
app.use(express.json({ limit: "500kb" }));

// ---------- DATABASE ----------
// The database is one file called lexi.db, created automatically.
const db = new DatabaseSync(path.join(__dirname, "lexi.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS passages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------- ROUTES ----------

// GET: send back all saved passages, newest first
app.get("/passages", function (req, res) {
  const rows = db
    .prepare("SELECT id, title, text, created_at FROM passages ORDER BY id DESC")
    .all();
  res.json(rows);
});

// POST: save a new passage
app.post("/passages", function (req, res) {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "";

  if (!text || text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }

  // The ? marks keep the user's text out of the SQL command (stops SQL injection)
  const result = db
    .prepare("INSERT INTO passages (title, text) VALUES (?, ?)")
    .run(title || "Untitled", text);

  // Keep only the newest 100 passages
  db.prepare(
    "DELETE FROM passages WHERE id NOT IN (SELECT id FROM passages ORDER BY id DESC LIMIT 100)"
  ).run();

  const saved = db
    .prepare("SELECT id, title, text, created_at FROM passages WHERE id = ?")
    .get(result.lastInsertRowid);
  res.status(201).json(saved);
});

// PUT: edit a saved passage
app.put("/passages/:id", function (req, res) {
  const id = Number(req.params.id);
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "";

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid passage id" });
  }
  if (!text || text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }

  const result = db
    .prepare("UPDATE passages SET text = ?, title = COALESCE(NULLIF(?, ''), title) WHERE id = ?")
    .run(text, title, id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Passage not found" });
  }

  const updated = db
    .prepare("SELECT id, title, text, created_at FROM passages WHERE id = ?")
    .get(id);
  res.json(updated);
});

// Serve the website itself (the "lexi" folder) from the same server
app.use(express.static(path.join(__dirname, "lexi")));

app.listen(process.env.PORT || 3000, function () {
  console.log("Lexi is running");
});
