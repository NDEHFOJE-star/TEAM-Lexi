const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "500kb" }));

const FILE = path.join(__dirname, "passages.json"); // created automatically

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch (e) { return []; }
}

// GET: send back all saved passages
app.get("/passages", function (req, res) {
  res.json(load());
});

// POST: save a new passage
app.post("/passages", function (req, res) {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "Untitled";

  if (!text || text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }

  const passage = { id: Date.now(), title: title || "Untitled", text: text };
  const list = load();
  list.unshift(passage);                                      // newest first
  fs.writeFileSync(FILE, JSON.stringify(list.slice(0, 100))); // keep the last 100
  res.status(201).json(passage);
});

// PUT: edit a saved passage
app.put("/passages/:id", function (req, res) {
  const id = Number(req.params.id);
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const title = typeof req.body.title === "string" ? req.body.title.trim().slice(0, 120) : "";

  if (!text || text.length > 50000) {
    return res.status(400).json({ error: "Text is required (max 50000 characters)" });
  }

  const list = load();
  const passage = list.find(function (p) { return p.id === id; });
  if (!passage) return res.status(404).json({ error: "Passage not found" });

  passage.text = text;
  if (title) passage.title = title;
  fs.writeFileSync(FILE, JSON.stringify(list));
  res.json(passage);
});

// Serve the website itself (the "lexi" folder) from the same server
app.use(express.static(path.join(__dirname, "lexi")));

app.listen(process.env.PORT || 3000, function () {
  console.log("Lexi is running");
});
