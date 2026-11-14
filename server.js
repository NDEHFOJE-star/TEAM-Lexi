const express = require("express");
const cors = require("cors");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use(cors());
app.use(express.json({ limit: "500kb" }));

const db = new DatabaseSync(path.join(__dirname, "lexi.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS passages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

app.get("/passages", function (req, res) {
  res.json(db.prepare("SELECT id, title, text, created_at FROM passages ORDER BY id DESC").all());
});

app.post("/passages", function (req, res) {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "";
  if (!text || text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }
  const result = db.prepare("INSERT INTO passages (title, text) VALUES (?, ?)").run(title || "Untitled", text);
  db.prepare("DELETE FROM passages WHERE id NOT IN (SELECT id FROM passages ORDER BY id DESC LIMIT 100)").run();
  res.status(201).json(
    db.prepare("SELECT id, title, text, created_at FROM passages WHERE id = ?").get(result.lastInsertRowid)
  );
});

app.put("/passages/:id", function (req, res) {
  const id = Number(req.params.id);
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "";
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid passage id" });
  if (!text || text.length > 50000) return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  const result = db
    .prepare("UPDATE passages SET text = ?, title = COALESCE(NULLIF(?, ''), title) WHERE id = ?")
    .run(text, title, id);
  if (result.changes === 0) return res.status(404).json({ error: "Passage not found" });
  res.json(db.prepare("SELECT id, title, text, created_at FROM passages WHERE id = ?").get(id));
});

app.delete("/passages/:id", function (req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid passage id" });
  const result = db.prepare("DELETE FROM passages WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Passage not found" });
  res.json({ deleted: id });
});

app.use(express.static(path.join(__dirname, "lexi")));

app.listen(process.env.PORT || 3000, function () {
  console.log("Lexi is running");
});
