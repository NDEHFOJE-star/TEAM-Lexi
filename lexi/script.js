// =====================================================================
// LEXI - script.js
//
// How this file is organised (top to bottom):
//   1. Helpers            small tools used everywhere (storage, toast)
//   2. SettingsModule     font, spacing, theme, tint - saved on the device
//   3. RulerModule        the reading ruler / focus mode
//   4. Navigation         switching between the four screens
//   5. Read aloud         voices, translation, highlighting, play/pause
//   6. WordHelper         tap a word: hear it, syllables, meaning, practice list
//   7. StatsModule        reading time, words read, streak, weekly chart
//   8. Library            talks to the backend (list, add, edit, delete)
//   9. Add-passage tools  clean text, upload files, scan photos (OCR), dialog
//  10. App                connects everything and starts it
// =====================================================================

// ---------------------------------------------------------------------
// 1. HELPERS
// ---------------------------------------------------------------------
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// Empty = "the same address as the website" (works on Render and on localhost:3000)
const API_URL = "";

const prefersReducedMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function countWords(text) {
  const matches = text.trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

function makeTitle(text) {
  const words = text.trim().split(/\s+/);
  const short = words.slice(0, 6).join(" ");
  return words.length > 6 ? short + "\u2026" : short;
}

function icon(name) {
  return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}

// Store: read and write small pieces of data in the browser (never crashes)
const Store = (() => {
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage is blocked or full: the app still works, it just won't remember */
    }
  }
  return { read, write };
})();

// Toast: the small message that pops up at the bottom
const Toast = (() => {
  const el = $("#toast");
  let timer = null;
  function show(message, type = "info") {
    if (!el) return;
    el.textContent = message;
    el.className = "toast show " + type;
    clearTimeout(timer);
    timer = setTimeout(() => el.classList.remove("show"), 3200);
  }
  return { show };
})();

// ---------------------------------------------------------------------
// 2. SETTINGS (saved in localStorage, applied with CSS variables)
// ---------------------------------------------------------------------
const SettingsModule = (() => {
  const KEY = "lexi.settings.v1";

  const FONTS = {
    lexend: "'Lexend', 'Segoe UI', Verdana, sans-serif",
    atkinson: "'Atkinson Hyperlegible', 'Segoe UI', Verdana, sans-serif",
    opendyslexic: "'OpenDyslexic', 'Comic Sans MS', sans-serif",
    verdana: "Verdana, Geneva, sans-serif",
    arial: "Arial, Helvetica, sans-serif",
    georgia: "Georgia, 'Times New Roman', serif"
  };

  const DEFAULTS = {
    font: "lexend",
    fontSize: 22,
    lineHeight: 1.9,
    letterSpacing: 1,
    wordSpacing: 4,
    theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    overlay: "none",
    ruler: "off",
    rulerLines: 2,
    speed: "1",
    voice: ""
  };

  let values = Object.assign({}, DEFAULTS, Store.read(KEY, {}));

  function get(key) {
    return values[key];
  }

  function set(key, value) {
    values[key] = value;
    Store.write(KEY, values);
    apply();
  }

  // Push the saved values into the page
  function apply() {
    const root = document.documentElement;
    root.style.setProperty("--read-font", FONTS[values.font] || FONTS.lexend);
    root.style.setProperty("--read-size", values.fontSize + "px");
    root.style.setProperty("--read-lh", values.lineHeight);
    root.style.setProperty("--read-ls", values.letterSpacing + "px");
    root.style.setProperty("--read-ws", values.wordSpacing + "px");
    root.dataset.theme = values.theme;
    root.dataset.overlay = values.overlay;
    document.body.dataset.ruler = values.ruler;

    // Keep every control showing the saved value
    $$("[data-setting]").forEach(function (el) {
      const key = el.dataset.setting;
      if (el.matches("input, select")) {
        if (el.value !== String(values[key])) el.value = values[key];
      } else {
        $$("button", el).forEach(function (button) {
          const on = button.dataset.value === String(values[key]);
          button.setAttribute("aria-checked", on ? "true" : "false");
          button.classList.toggle("selected", on);
        });
      }
    });
    $$("output[data-for]").forEach(function (out) {
      out.textContent = values[out.dataset.for] + (out.dataset.unit || "");
    });

    RulerModule.refresh();
  }

  function reset() {
    const keepVoice = values.voice;
    values = Object.assign({}, DEFAULTS, { voice: keepVoice });
    Store.write(KEY, values);
    apply();
  }

  function init() {
    // sliders and drop-downs
    $$("input[data-setting], select[data-setting]").forEach(function (el) {
      el.addEventListener("input", function () {
        set(el.dataset.setting, el.type === "range" ? Number(el.value) : el.value);
      });
    });
    // button groups (theme, tint, ruler mode)
    $$("div[data-setting]").forEach(function (group) {
      group.addEventListener("click", function (e) {
        const button = e.target.closest("button");
        if (button) set(group.dataset.setting, button.dataset.value);
      });
    });
    $("#resetSettingsBtn").addEventListener("click", function () {
      reset();
      Toast.show("Settings reset to defaults", "success");
    });
    apply();
  }

  return { init, get, set };
})();

// ---------------------------------------------------------------------
// 3. READING RULER (band = highlight one strip, focus = dim everything else)
// ---------------------------------------------------------------------
const RulerModule = (() => {
  const band = $("#rulerBand");
  const card = $("#readerCard");
  const label = $("#rulerLabel");
  const toggle = $("#rulerToggle");
  let centreY = null; // where the ruler is, in screen pixels

  function height() {
    return Math.round(
      SettingsModule.get("rulerLines") * SettingsModule.get("fontSize") * SettingsModule.get("lineHeight")
    );
  }

  function position() {
    if (!band || !card) return;
    const rect = card.getBoundingClientRect();
    const h = height();
    const centre = centreY === null ? window.innerHeight * 0.4 : centreY;
    const top = Math.max(0, Math.min(window.innerHeight - h, centre - h / 2));
    band.style.height = h + "px";
    band.style.top = top + "px";
    band.style.left = rect.left + "px";
    band.style.width = rect.width + "px";
  }

  function moveTo(clientY) {
    centreY = clientY;
    position();
  }

  // While reading aloud, the ruler follows the word being spoken
  function followElement(el) {
    const rect = el.getBoundingClientRect();
    centreY = rect.top + rect.height / 2;
    position();
  }

  function refresh() {
    const mode = SettingsModule.get("ruler");
    const names = { off: "Off", band: "Band", focus: "Focus" };
    if (label) label.textContent = "Ruler: " + names[mode];
    if (toggle) toggle.setAttribute("aria-pressed", mode !== "off" ? "true" : "false");
    position();
  }

  function cycle() {
    const order = ["off", "band", "focus"];
    const next = order[(order.indexOf(SettingsModule.get("ruler")) + 1) % order.length];
    SettingsModule.set("ruler", next);
  }

  function init() {
    if (toggle) toggle.addEventListener("click", cycle);
    if (card) {
      card.addEventListener("pointermove", function (e) {
        if (SettingsModule.get("ruler") !== "off") moveTo(e.clientY);
      });
    }
    window.addEventListener("resize", position);
  }

  return { init, refresh, position, moveTo, followElement };
})();

// ---------------------------------------------------------------------
// 4. NAVIGATION (four screens: library, reader, insights, settings)
// ---------------------------------------------------------------------
const Nav = (() => {
  function show(id) {
    if (id !== "reader") resetAudio(); // stop speaking when leaving the reader
    WordHelper.close();

    $$(".screen").forEach(function (screen) {
      screen.classList.toggle("active", screen.id === id);
    });
    $$(".nav-item").forEach(function (button) {
      const on = button.dataset.screen === id;
      button.classList.toggle("active", on);
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.body.dataset.screen = id;
    window.scrollTo(0, 0);

    if (id === "insights") InsightsView.render();
    if (id === "reader") RulerModule.position();
  }

  function init() {
    $$(".nav-item").forEach(function (button) {
      button.addEventListener("click", function () {
        show(button.dataset.screen);
      });
    });
    $("#backBtn").addEventListener("click", function () { show("library"); });
    $("#goLibraryBtn").addEventListener("click", function () { show("library"); });
  }

  return { init, show };
})();

// ---------------------------------------------------------------------
// 5. READ ALOUD (browser voice) with word highlighting, pause/resume and
//    automatic translation
// ---------------------------------------------------------------------
const TTS_SUPPORTED = !!window.speechSynthesis;
const synth = window.speechSynthesis || {
  getVoices() { return []; },
  cancel() { },
  speak() { },
  addEventListener() { }
};

const playPauseBtn = $("#playPauseBtn");
const stopBtn = $("#stopBtn");
const speedControl = $("#speedControl");
const voiceControl = $("#voiceControl");
const readingText = $("#readingText");
const readProgress = $("#readProgress");

const SOURCE_LANG = "en"; // the language your passages are written in
const LANGUAGE_NAMES = { en: "English", fr: "French" };

let currentPassage = null; // { id, title, text } - the passage open in the reader

function setStatus(message) {
  $("#statusLine").textContent = message;
}

// The play button shows Play, Pause or a spinner
function setPlayState(state) {
  const labels = { play: "Play", pause: "Pause", loading: "Preparing" };
  playPauseBtn.dataset.state = state;
  playPauseBtn.setAttribute("aria-label", labels[state]);
  playPauseBtn.title = labels[state] + " (Space)";
  if (state === "loading") {
    playPauseBtn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>Preparing</span>';
  } else {
    playPauseBtn.innerHTML = icon(state === "pause" ? "pause" : "play") + "<span>" + labels[state] + "</span>";
  }
}

// Fill the voice list: English (Aria, Guy) and French (Denise, Henri) if present
function loadVoices() {
  const allVoices = synth.getVoices();
  if (allVoices.length === 0) return;

  const languages = {
    en: { label: "English", preferred: ["Aria", "Guy"] },
    fr: { label: "Fran\u00e7ais", preferred: ["Denise", "Henri"] }
  };

  let chosenVoices = [];
  Object.keys(languages).forEach(function (code) {
    const ofLanguage = allVoices.filter(function (v) {
      return v.lang.toLowerCase().startsWith(code);
    });
    const picked = [];
    languages[code].preferred.forEach(function (name) {
      const match = ofLanguage.find(function (v) { return v.name.includes(name); });
      if (match) picked.push(match);
    });
    ofLanguage.forEach(function (v) {
      if (picked.length < 2 && !picked.includes(v)) picked.push(v);
    });
    chosenVoices = chosenVoices.concat(picked);
  });
  if (chosenVoices.length === 0) return; // keep "Default voice"

  const wanted = SettingsModule.get("voice") || voiceControl.value;

  voiceControl.innerHTML = "";
  chosenVoices.forEach(function (v) {
    const shortName = v.name
      .replace(/^(Microsoft|Google)\s*/, "")
      .replace(/\s*-.*$/, "")
      .replace(/\s*\(.*\)/, "")
      .replace(/\s*Online\s*/, "");
    const language = languages[v.lang.slice(0, 2).toLowerCase()].label;
    voiceControl.add(new Option(shortName + " (" + language + ")", v.name));
  });

  const stillThere = Array.from(voiceControl.options).some(function (o) { return o.value === wanted; });
  if (wanted && stillThere) voiceControl.value = wanted;
}

function getSelectedVoice() {
  return synth.getVoices().find(function (v) { return v.name === voiceControl.value; }) || null;
}

function getSelectedLanguage() {
  const voice = getSelectedVoice();
  return voice ? voice.lang.slice(0, 2).toLowerCase() : SOURCE_LANG;
}

// ---------- translation ----------
// 1) the translator built into newer Edge/Chrome  2) the free MyMemory service
// 3) if both fail, the original text is read instead
let originalText = null;
let displayedLang = SOURCE_LANG;
let viewToken = 0;
const translationCache = {};

function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

function splitLines(text) {
  return text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
}

function chunkText(text, maxLength) {
  const chunks = [];
  let current = "";
  splitIntoSentences(text).forEach(function (s) {
    if (current && (current + " " + s).length > maxLength) {
      chunks.push(current);
      current = s;
    } else {
      current = current ? current + " " + s : s;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

async function translateWithBrowser(text, target) {
  if (!("Translator" in self)) return null;
  const options = { sourceLanguage: SOURCE_LANG, targetLanguage: target };
  const availability = await Translator.availability(options);
  if (availability === "unavailable") return null;
  const translator = await Translator.create(options);
  const out = [];
  for (const line of splitLines(text)) {
    out.push(await translator.translate(line));
  }
  return out.join("\n\n");
}

async function translateOnline(text, target) {
  const out = [];
  for (const line of splitLines(text)) {
    const parts = [];
    for (const chunk of chunkText(line, 450)) {
      const url = "https://api.mymemory.translated.net/get?q=" +
        encodeURIComponent(chunk) + "&langpair=" + SOURCE_LANG + "|" + target;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Translation request failed");
      const data = await response.json();
      if (Number(data.responseStatus) !== 200 || !data.responseData) {
        throw new Error("Translation not available");
      }
      parts.push(decodeEntities(data.responseData.translatedText));
    }
    out.push(parts.join(" "));
  }
  return out.join("\n\n");
}

async function getTranslation(text, target) {
  const key = target + "|" + text;
  if (translationCache[key]) return translationCache[key];
  let result = null;
  try {
    result = await translateWithBrowser(text, target);
  } catch (e) {
    console.warn("Browser translator failed:", e);
  }
  if (!result) {
    try {
      result = await translateOnline(text, target);
    } catch (e) {
      console.warn("Online translator failed:", e);
    }
  }
  if (result) translationCache[key] = result;
  return result;
}

function showOriginal() {
  renderWordSpans(originalText);
  displayedLang = SOURCE_LANG;
  setStatus("");
}

// Shows (and returns) the text that matches the chosen voice's language
async function showTextForCurrentVoice() {
  const token = ++viewToken;
  const target = getSelectedLanguage();

  if (target === SOURCE_LANG) {
    showOriginal();
    return originalText;
  }

  setStatus("Translating\u2026");
  const translated = await getTranslation(originalText, target);
  if (token !== viewToken) return null; // the user changed something meanwhile

  if (translated) {
    renderWordSpans(translated);
    displayedLang = target;
    setStatus("Reading a " + (LANGUAGE_NAMES[target] || target) + " translation.");
    return translated;
  }

  showOriginal();
  setStatus("Translation isn't available right now, so the original text will be read.");
  return originalText;
}

// ---------- opening a passage in the reader ----------
function loadPassageIntoReader(passage) {
  resetAudio();
  currentPassage = passage;
  originalText = passage.text;
  displayedLang = SOURCE_LANG;
  viewToken++;
  setStatus("");
  renderWordSpans(passage.text);

  const words = countWords(passage.text);
  const minutes = Math.max(1, Math.round(words / 150));
  $("#readingTitle").textContent = passage.title || "Your passage";
  $("#readingMeta").textContent = words + " words \u00b7 about " + minutes + " min read aloud";
  $("#readerEmpty").classList.add("hidden");
  $("#readerBody").classList.remove("hidden");
}

function showReaderEmpty() {
  resetAudio();
  currentPassage = null;
  originalText = null;
  $("#readerBody").classList.add("hidden");
  $("#readerEmpty").classList.remove("hidden");
}

// ---------- word highlighting ----------
let wordSpans = [];
let wordOffsets = [];
let sentenceStarts = [];
let currentHighlighted = null;

// Turns the text into <span class="word"> pieces so each word can be
// highlighted while reading and tapped for help.
function renderWordSpans(text) {
  let html = "";
  const offsets = [];
  const regex = /\S+/g;
  let match;
  let lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    html += escapeHtml(text.slice(lastIndex, match.index));
    const start = match.index;
    const end = start + match[0].length;
    html += '<span class="word" data-start="' + start + '">' + escapeHtml(match[0]) + "</span>";
    offsets.push({ start: start, end: end });
    lastIndex = end;
  }
  html += escapeHtml(text.slice(lastIndex));

  readingText.innerHTML = html;
  wordSpans = Array.from(readingText.querySelectorAll(".word"));
  wordOffsets = offsets;
  currentHighlighted = null;
}

function getSentenceStarts(text, sentenceList) {
  const starts = [];
  let cursor = 0;
  sentenceList.forEach(function (s) {
    const idx = text.indexOf(s, cursor);
    const start = idx === -1 ? cursor : idx;
    starts.push(start);
    cursor = start + s.length;
  });
  return starts;
}

function keepInView(el) {
  const rect = el.getBoundingClientRect();
  if (rect.top < 100 || rect.bottom > window.innerHeight - 100) {
    const instant = prefersReducedMotion || SettingsModule.get("ruler") !== "off";
    el.scrollIntoView({ block: "center", behavior: instant ? "auto" : "smooth" });
  }
}

function highlightWordAt(absolutePosition) {
  let target = null;
  for (let i = 0; i < wordOffsets.length; i++) {
    if (wordOffsets[i].start <= absolutePosition) {
      target = wordSpans[i];
    } else {
      break;
    }
  }
  if (currentHighlighted && currentHighlighted !== target) {
    currentHighlighted.classList.remove("highlight");
  }
  if (target) {
    target.classList.add("highlight");
    currentHighlighted = target;
    keepInView(target);
    if (SettingsModule.get("ruler") !== "off") RulerModule.followElement(target);
  }
}

function clearHighlight() {
  if (currentHighlighted) {
    currentHighlighted.classList.remove("highlight");
    currentHighlighted = null;
  }
}

// ---------- listening time (for Insights) ----------
let listenStart = null;
function startTimer() {
  if (listenStart === null) listenStart = Date.now();
}
function stopTimer() {
  if (listenStart !== null) {
    StatsModule.addSeconds((Date.now() - listenStart) / 1000);
    listenStart = null;
  }
}

// ---------- reading aloud ----------
let sentences = [];
let currentIndex = 0;
let wordOffset = 0;
let utteranceStart = 0;
let isPlaying = false;
let isPaused = false;
let isTranslating = false;
let runId = 0; // every new run gets a new number so old callbacks can be ignored
let currentUtterance = null;

function splitIntoSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  return parts
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; });
}

function finishReading() {
  stopTimer();
  isPlaying = false;
  isPaused = false;
  isTranslating = false;
  currentIndex = 0;
  wordOffset = 0;
  currentUtterance = null;
  clearHighlight();
  readProgress.style.width = "0%";
  setPlayState("play");
}

function resetAudio() {
  runId++;
  synth.cancel();
  finishReading();
}

function pauseReading() {
  if (!isPlaying || isPaused) return;
  const sentence = sentences[currentIndex];
  if (sentence) StatsModule.addWords(countWords(sentence.slice(utteranceStart, wordOffset)));
  isPaused = true;
  runId++;
  synth.cancel();
  stopTimer();
  setPlayState("play");
}

function speakCurrentSentence(myRun) {
  if (myRun !== runId) return;
  if (currentIndex >= sentences.length) {
    StatsModule.addCompletion();
    finishReading();
    return;
  }

  readProgress.style.width = Math.round((currentIndex / sentences.length) * 100) + "%";

  const fullSentence = sentences[currentIndex];
  const startOffset = wordOffset;
  utteranceStart = startOffset;
  if (startOffset >= fullSentence.length) {
    currentIndex++;
    wordOffset = 0;
    speakCurrentSentence(myRun);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(fullSentence.slice(startOffset));
  currentUtterance = utterance;

  const speed = parseFloat(speedControl.value);
  utterance.rate = isNaN(speed) ? 1 : speed;

  const chosen = getSelectedVoice();
  if (chosen) utterance.voice = chosen;

  utterance.addEventListener("boundary", function (e) {
    if (myRun !== runId) return;
    if (e.name && e.name !== "word") return;
    wordOffset = startOffset + e.charIndex;
    highlightWordAt(sentenceStarts[currentIndex] + wordOffset);
  });

  utterance.addEventListener("end", function () {
    if (myRun !== runId) return;
    StatsModule.addWords(countWords(fullSentence.slice(startOffset)));
    currentIndex++;
    wordOffset = 0;
    speakCurrentSentence(myRun);
  });
  utterance.addEventListener("error", function () {
    if (myRun !== runId) return;
    finishReading();
  });

  synth.speak(utterance);
}

function resumeFromCurrentSentence() {
  runId++;
  const myRun = runId;
  synth.cancel();
  setTimeout(function () {
    speakCurrentSentence(myRun);
  }, 60);
}

async function onPlayPause() {
  if (isTranslating) return;
  if (!TTS_SUPPORTED) {
    Toast.show("Your browser can't read aloud. Try Chrome or Edge.", "error");
    return;
  }
  if (!currentPassage || originalText === null) {
    Toast.show("Open a passage first.", "error");
    return;
  }

  if (!isPlaying) {
    isTranslating = true;
    const myRun = ++runId;
    setPlayState("loading");

    const text = await showTextForCurrentVoice();
    if (myRun !== runId) return;
    if (text === null) { finishReading(); return; }

    isTranslating = false;
    renderWordSpans(text);
    sentences = splitIntoSentences(text);
    sentenceStarts = getSentenceStarts(text, sentences);
    currentIndex = 0;
    wordOffset = 0;
    isPlaying = true;
    isPaused = false;
    setPlayState("pause");
    startTimer();
    resumeFromCurrentSentence();
  } else if (isPaused) {
    isPaused = false;
    setPlayState("pause");
    startTimer();
    resumeFromCurrentSentence();
  } else {
    pauseReading();
  }
}

function applyNewSetting() {
  if (isPlaying && !isPaused) {
    resumeFromCurrentSentence();
  }
}

function initReadAloud() {
  setPlayState("play");
  loadVoices();
  synth.addEventListener("voiceschanged", loadVoices);

  playPauseBtn.addEventListener("click", onPlayPause);
  stopBtn.addEventListener("click", resetAudio);
  speedControl.addEventListener("change", applyNewSetting);

  voiceControl.addEventListener("change", async function () {
    SettingsModule.set("voice", voiceControl.value);
    if (!currentPassage) return;
    if (getSelectedLanguage() !== displayedLang) {
      resetAudio();
      await showTextForCurrentVoice();
    } else {
      applyNewSetting();
    }
  });

  // Tap a word to get help
  readingText.addEventListener("click", function (e) {
    const span = e.target.closest(".word");
    if (span) WordHelper.openFromSpan(span);
  });

  // Space = play / pause (when you are not typing in a field)
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      WordHelper.close();
      return;
    }
    if (e.code !== "Space" || document.body.dataset.screen !== "reader") return;
    if ($("#addDialog").open) return;
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
    e.preventDefault();
    onPlayPause();
  });

  window.addEventListener("pagehide", stopTimer);
}

// ---------------------------------------------------------------------
// 6. WORD HELPER (tap a word: hear it, syllables, meaning, practice list)
// ---------------------------------------------------------------------
const WordHelper = (() => {
  const KEY = "lexi.words.v1";
  const card = $("#wordCard");
  let words = Store.read(KEY, {}); // { "dyslexia": { count: 3, last: 1731500000000 } }
  const definitionCache = new Map();
  let definitionToken = 0;
  let pickedSpan = null;

  // Remove punctuation from both ends of a tapped word
  function cleanWord(raw) {
    return raw.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  }

  // ---- splitting a word into syllables (an approximation, good for English) ----
  const DIGRAPHS = ["th", "sh", "ch", "ph", "wh", "ck", "ng", "gh"];

  function syllabify(word) {
    if (/[^A-Za-z]/.test(word)) return [word];
    const w = word.toLowerCase();
    if (w.length < 4) return [word];

    const isVowel = function (c, i) { return "aeiou".includes(c) || (c === "y" && i > 0); };

    // 1. find groups of vowels (each group is the heart of one syllable)
    const nuclei = [];
    let i = 0;
    while (i < w.length) {
      if (isVowel(w[i], i)) {
        let j = i;
        while (j + 1 < w.length && isVowel(w[j + 1], j + 1)) j++;
        nuclei.push({ start: i, end: j });
        i = j + 1;
      } else {
        i++;
      }
    }
    if (nuclei.length < 2 && !/[^aeiouy]le$/.test(w)) return [word];

    const cuts = []; // positions where a new syllable begins
    const last = nuclei[nuclei.length - 1];

    // 2. endings: "-ble", "-tle" keep their own syllable; a silent "e" or "-ed" joins the one before
    if (/[^aeiouy]le$/.test(w) && last.start === w.length - 1 && nuclei.length >= 2) {
      let cut = w.length - 3;
      cuts.push(cut);
      nuclei.pop();
    } else if (/[^aeiouy]le$/.test(w) && nuclei.length === 1) {
      return [word];
    } else if (last.start === w.length - 1 && last.end === w.length - 1 && w.endsWith("e") && nuclei.length > 1) {
      nuclei.pop();
    } else if (/[^td]ed$/.test(w) && last.start === w.length - 2 && nuclei.length > 1) {
      nuclei.pop();
    }

    // 3. split inside vowel pairs that are really two sounds (dys-lex-i-a, ra-di-o)
    const inner = [];
    nuclei.forEach(function (n) {
      if (n.end - n.start === 1) {
        const pair = w.slice(n.start, n.end + 1);
        const before = w[n.start - 1] || "";
        const atEnd = n.end >= w.length - 1;
        if (pair === "ia" && !"tcs".includes(before || "-")) inner.push(n.start + 1);
        if (pair === "io" && atEnd) inner.push(n.start + 1);
        if (pair === "ua" && !"qg".includes(before || "-")) inner.push(n.start + 1);
      }
    });

    // 4. decide where to cut between neighbouring vowel groups
    for (let k = 0; k < nuclei.length - 1; k++) {
      const between = w.slice(nuclei[k].end + 1, nuclei[k + 1].start);
      const gapStart = nuclei[k].end + 1;
      if (between.length === 1) {
        cuts.push(between === "x" ? gapStart + 1 : gapStart);      // re-ding, lex-ia
      } else if (between.length >= 2) {
        if (between.length === 2 && DIGRAPHS.includes(between)) {
          cuts.push(gapStart);                                      // mo-ther
        } else {
          cuts.push(gapStart + 1);                                  // run-ning, ex-plain
        }
      }
    }

    const all = cuts.concat(inner)
      .filter(function (c) { return c > 0 && c < w.length; })
      .sort(function (a, b) { return a - b; })
      .filter(function (c, idx, arr) { return idx === 0 || c !== arr[idx - 1]; });

    const parts = [];
    let from = 0;
    all.forEach(function (c) {
      parts.push(word.slice(from, c));
      from = c;
    });
    parts.push(word.slice(from));
    return parts.filter(Boolean);
  }

  // ---- speaking ----
  function speakPiece(text, rate) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    const voice = getSelectedVoice();
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  }

  function hear(word) {
    if (!TTS_SUPPORTED) { Toast.show("Your browser can't read aloud.", "error"); return; }
    pauseReading();
    synth.cancel();
    speakPiece(word, 0.85);
  }

  function hearBySyllable(word) {
    if (!TTS_SUPPORTED) { Toast.show("Your browser can't read aloud.", "error"); return; }
    pauseReading();
    synth.cancel();
    syllabify(word).forEach(function (part) { speakPiece(part, 0.6); });
    speakPiece(word, 0.85);
  }

  // ---- meaning (free dictionary service, English only) ----
  async function fetchDefinition(word) {
    const key = word.toLowerCase();
    if (definitionCache.has(key)) return definitionCache.get(key);
    const response = await fetch("https://api.dictionaryapi.dev/v2/entries/en/" + encodeURIComponent(key));
    if (!response.ok) {
      definitionCache.set(key, null);
      return null;
    }
    const data = await response.json();
    const meanings = [];
    (data[0].meanings || []).slice(0, 2).forEach(function (m) {
      const first = m.definitions && m.definitions[0];
      if (first) meanings.push({ pos: m.partOfSpeech, text: first.definition, example: first.example || "" });
    });
    definitionCache.set(key, meanings);
    return meanings;
  }

  async function showDefinition(word) {
    const box = $("#wcDef");
    const token = ++definitionToken;
    box.textContent = "";

    if (displayedLang !== SOURCE_LANG) {
      box.textContent = "Meanings are available for English text only.";
      return;
    }
    box.textContent = "Looking up the meaning\u2026";
    try {
      const meanings = await fetchDefinition(word);
      if (token !== definitionToken) return;
      box.textContent = "";
      if (!meanings || meanings.length === 0) {
        box.textContent = "No meaning found for this word.";
        return;
      }
      meanings.forEach(function (m) {
        const wrap = document.createElement("div");
        wrap.className = "meaning";
        const pos = document.createElement("span");
        pos.className = "pos";
        pos.textContent = m.pos;
        wrap.appendChild(pos);
        wrap.appendChild(document.createTextNode(m.text));
        if (m.example) {
          const ex = document.createElement("div");
          ex.className = "example";
          ex.textContent = "\u201c" + m.example + "\u201d";
          wrap.appendChild(ex);
        }
        box.appendChild(wrap);
      });
    } catch (e) {
      if (token !== definitionToken) return;
      box.textContent = "Couldn't look up the meaning. Check your internet connection.";
    }
  }

  // ---- the card ----
  function open(rawWord, countIt) {
    const word = cleanWord(rawWord);
    if (!word) return;
    const key = word.toLowerCase();

    if (countIt) {
      const entry = words[key] || { count: 0, last: 0 };
      entry.count += 1;
      entry.last = Date.now();
      words[key] = entry;
      Store.write(KEY, words);
    }

    const parts = syllabify(word);
    $("#wcWord").textContent = word;
    $("#wcSyll").textContent = parts.length > 1 ? parts.join(" \u00b7 ") : "1 syllable";
    const times = words[key] ? words[key].count : 0;
    $("#wcCount").textContent = times > 0
      ? "You've looked up this word " + times + (times === 1 ? " time." : " times.")
      : "";

    $("#wcHear").onclick = function () { hear(word); };
    $("#wcSlow").onclick = function () { hearBySyllable(word); };
    $("#wcSlow").classList.toggle("hidden", parts.length < 2);

    card.classList.remove("hidden");
    showDefinition(word);
  }

  function openFromSpan(span) {
    if (pickedSpan) pickedSpan.classList.remove("picked");
    pickedSpan = span;
    span.classList.add("picked");
    open(span.textContent, true);
  }

  function close() {
    card.classList.add("hidden");
    definitionToken++;
    if (pickedSpan) {
      pickedSpan.classList.remove("picked");
      pickedSpan = null;
    }
  }

  // ---- the practice list (shown on the Insights screen) ----
  function list() {
    return Object.keys(words)
      .map(function (w) { return { word: w, count: words[w].count, last: words[w].last }; })
      .sort(function (a, b) { return b.count - a.count || b.last - a.last; })
      .slice(0, 30);
  }

  function remove(word) {
    delete words[word];
    Store.write(KEY, words);
  }

  function clearAll() {
    words = {};
    Store.write(KEY, words);
  }

  function init() {
    $("#wcClose").addEventListener("click", close);
  }

  return { init, open, openFromSpan, close, list, remove, clearAll, syllabify, hear };
})();

// ---------------------------------------------------------------------
// 7. STATS (reading time, words, streak) and the Insights screen
// ---------------------------------------------------------------------
const StatsModule = (() => {
  const KEY = "lexi.stats.v1";
  const data = Object.assign({ totalSeconds: 0, totalWords: 0, completed: 0, days: {} }, Store.read(KEY, {}));

  function dayKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function today() {
    const key = dayKey(new Date());
    if (!data.days[key]) data.days[key] = { s: 0, w: 0 };
    return data.days[key];
  }
  function save() {
    Store.write(KEY, data);
  }

  function addSeconds(seconds) {
    if (seconds < 0.5) return;
    data.totalSeconds += seconds;
    today().s += seconds;
    save();
  }
  function addWords(count) {
    if (!count) return;
    data.totalWords += count;
    today().w += count;
    save();
  }
  function addCompletion() {
    data.completed += 1;
    save();
  }

  // How many days in a row you have read (today may still be empty)
  function streak() {
    const date = new Date();
    const active = function (d) {
      const e = data.days[dayKey(d)];
      return !!e && (e.s > 0 || e.w > 0);
    };
    if (!active(date)) date.setDate(date.getDate() - 1);
    let count = 0;
    while (active(date)) {
      count++;
      date.setDate(date.getDate() - 1);
    }
    return count;
  }

  function lastSevenDays() {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const entry = data.days[dayKey(d)] || { s: 0, w: 0 };
      out.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), seconds: entry.s, words: entry.w });
    }
    return out;
  }

  function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (seconds < 60) return Math.round(seconds) + "s";
    if (minutes < 60) return minutes + "m";
    return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }

  return { addSeconds, addWords, addCompletion, streak, lastSevenDays, formatDuration, totals: function () { return data; } };
})();

const InsightsView = (() => {
  function renderChart() {
    const chart = $("#weekChart");
    chart.innerHTML = "";
    const week = StatsModule.lastSevenDays();
    const max = Math.max.apply(null, week.map(function (d) { return d.seconds; }).concat([1]));

    week.forEach(function (day) {
      const col = document.createElement("div");
      col.className = "bar-col";

      const value = document.createElement("span");
      value.className = "bar-value";
      value.textContent = day.seconds > 0 ? (day.seconds < 60 ? "<1m" : Math.round(day.seconds / 60) + "m") : "";

      const bar = document.createElement("div");
      bar.className = "bar" + (day.seconds > 0 ? "" : " zero");
      bar.style.height = day.seconds > 0 ? Math.max(6, Math.round((day.seconds / max) * 110)) + "px" : "4px";
      bar.title = day.label + ": " + StatsModule.formatDuration(day.seconds) + ", " + day.words + " words";

      const label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = day.label;

      col.appendChild(value);
      col.appendChild(bar);
      col.appendChild(label);
      chart.appendChild(col);
    });
  }

  function renderWords() {
    const ul = $("#wordList");
    ul.innerHTML = "";
    const items = WordHelper.list();
    $("#wordEmpty").classList.toggle("hidden", items.length > 0);
    $("#clearWordsBtn").classList.toggle("hidden", items.length === 0);

    items.forEach(function (item) {
      const li = document.createElement("li");

      const word = document.createElement("span");
      word.className = "wl-word";
      word.textContent = item.word;

      const syll = document.createElement("span");
      syll.className = "wl-syll";
      syll.textContent = WordHelper.syllabify(item.word).join(" \u00b7 ");

      const count = document.createElement("span");
      count.className = "wl-count";
      count.textContent = "\u00d7" + item.count;

      const hear = document.createElement("button");
      hear.type = "button";
      hear.className = "icon-btn";
      hear.setAttribute("aria-label", "Hear " + item.word);
      hear.innerHTML = icon("volume");
      hear.addEventListener("click", function () { WordHelper.hear(item.word); });

      const info = document.createElement("button");
      info.type = "button";
      info.className = "btn btn-ghost btn-sm";
      info.textContent = "Meaning";
      info.addEventListener("click", function () { WordHelper.open(item.word, false); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.setAttribute("aria-label", "Remove " + item.word + " from the list");
      del.innerHTML = icon("x");
      del.addEventListener("click", function () {
        WordHelper.remove(item.word);
        renderWords();
      });

      [word, syll, count, hear, info, del].forEach(function (node) { li.appendChild(node); });
      ul.appendChild(li);
    });
  }

  function render() {
    const totals = StatsModule.totals();
    $("#statStreak").textContent = StatsModule.streak();
    $("#statWords").textContent = Math.round(totals.totalWords).toLocaleString();
    $("#statTime").textContent = StatsModule.formatDuration(totals.totalSeconds);
    $("#statDone").textContent = totals.completed;
    renderChart();
    renderWords();
  }

  function init() {
    $("#clearWordsBtn").addEventListener("click", function () {
      if (confirm("Clear your whole practice list?")) {
        WordHelper.clearAll();
        renderWords();
      }
    });
  }

  return { init, render };
})();

// ---------------------------------------------------------------------
// 8. LIBRARY (the Home screen) - talks to the backend
// ---------------------------------------------------------------------
const SAMPLE_PASSAGE = {
  title: "Welcome to Lexi",
  text: "Welcome to Lexi. Lexi helps you read with less effort. Press play and the words light up as they are spoken. " +
    "Tap any word to hear it, see how it splits into syllables, and read what it means. " +
    "Try the reading ruler in the player bar to keep your place on the line."
};

const Library = (() => {
  let passages = [];
  let failed = false;
  const grid = $("#passageList");
  const status = $("#passageStatus");
  const retry = $("#retryBtn");
  const empty = $("#emptyState");
  const search = $("#searchInput");

  async function request(path, options) {
    const response = await fetch(API_URL + path, options);
    if (!response.ok) throw new Error("Server said " + response.status);
    return response.json();
  }

  function jsonOptions(method, body) {
    return { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  function create(text, title) { return request("/passages", jsonOptions("POST", { title: title, text: text })); }
  function update(id, text, title) { return request("/passages/" + id, jsonOptions("PUT", { title: title, text: text })); }
  function remove(id) { return request("/passages/" + id, { method: "DELETE" }); }

  async function refresh() {
    if (passages.length === 0) status.textContent = "Loading your passages\u2026";
    try {
      const result = await request("/passages");
      if (!Array.isArray(result)) throw new Error("Unexpected answer from the server");
      passages = result;
      failed = false;
    } catch (e) {
      failed = true;
    }
    draw();
  }

  function formatDate(value) {
    if (!value) return "";
    const date = new Date(String(value).replace(" ", "T") + "Z");
    return isNaN(date) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function draw() {
    const term = search.value.trim().toLowerCase();
    const shown = passages.filter(function (p) {
      return !term || p.title.toLowerCase().includes(term) || p.text.toLowerCase().includes(term);
    });

    grid.innerHTML = "";
    retry.classList.toggle("hidden", !failed);
    $("#libSubtitle").textContent = passages.length === 1 ? "1 saved passage" : passages.length + " saved passages";

    if (failed) {
      status.textContent = "Could not reach the server. Check your connection and try again.";
      empty.classList.add("hidden");
      return;
    }
    status.textContent = term && shown.length === 0 ? "No passages match \u201c" + search.value.trim() + "\u201d." : "";
    empty.classList.toggle("hidden", passages.length > 0);

    shown.forEach(function (p) {
      const card = document.createElement("article");
      card.className = "p-card";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "p-open";
      open.setAttribute("aria-label", "Open " + p.title);

      const title = document.createElement("h3");
      title.className = "p-title";
      title.textContent = p.title;

      const excerpt = document.createElement("p");
      excerpt.className = "p-excerpt";
      excerpt.textContent = p.text;

      const meta = document.createElement("p");
      meta.className = "p-meta";
      const words = countWords(p.text);
      [words + " words", "~" + Math.max(1, Math.round(words / 150)) + " min", formatDate(p.created_at)]
        .filter(Boolean)
        .forEach(function (piece) {
          const span = document.createElement("span");
          span.textContent = piece;
          meta.appendChild(span);
        });

      open.appendChild(title);
      open.appendChild(excerpt);
      open.appendChild(meta);
      open.addEventListener("click", function () { App.openPassage({ id: p.id, title: p.title, text: p.text }); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn p-del";
      del.setAttribute("aria-label", "Delete " + p.title);
      del.title = "Delete";
      del.innerHTML = icon("trash");
      del.addEventListener("click", function () { deleteWithConfirm(p); });

      card.appendChild(open);
      card.appendChild(del);
      grid.appendChild(card);
    });
  }

  async function deleteWithConfirm(p) {
    if (!confirm("Delete \u201c" + p.title + "\u201d? This can't be undone.")) return;
    try {
      await remove(p.id);
      if (currentPassage && currentPassage.id === p.id) showReaderEmpty();
      Toast.show("Passage deleted", "success");
      await refresh();
    } catch (e) {
      Toast.show("Could not delete the passage.", "error");
    }
  }

  function init() {
    search.addEventListener("input", draw);
    retry.addEventListener("click", refresh);
    $("#newPassageBtn").addEventListener("click", function () { AddDialog.open({ mode: "new" }); });
    $("#emptyAddBtn").addEventListener("click", function () { AddDialog.open({ mode: "new" }); });
    $("#sampleBtn").addEventListener("click", function () {
      App.saveAndOpen(SAMPLE_PASSAGE.text, SAMPLE_PASSAGE.title);
    });
    refresh();
  }

  return { init, refresh, create, update, remove };
})();

// ---------------------------------------------------------------------
// 9. ADD A PASSAGE: clean text, upload a file, scan a photo, the dialog
// ---------------------------------------------------------------------

const TextCleaner = (() => {
  function clean(raw) {
    if (!raw || typeof raw !== "string") return "";
    let text = raw;
    text = text.normalize("NFKC");
    text = text
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u2026/g, "...");
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    text = text.replace(/-\s*\n\s*/g, "");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.split("\n").map(function (line) { return line.trim(); }).join("\n");
    text = text.replace(/\bl\b/g, "I").replace(/\s+([.,!?;:])/g, "$1");
    return text.trim();
  }
  return { clean };
})();

const FileUploadModule = (() => {
  const dropZone = $("#dropZone");
  const fileInput = $("#fileInput");
  const filePreview = $("#filePreview");
  const fileName = $("#fileName");
  const fileSize = $("#fileSize");
  const removeBtn = $("#removeFileBtn");
  const processBtn = $("#processFileBtn");

  if (!dropZone || !fileInput) {
    console.warn("[FileUploadModule] elements not found - skipping init");
    return { init: function () { } };
  }

  let selectedFile = null;

  const ACCEPTED = {
    "text/plain": "txt",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc"
  };
  const MAX_SIZE_MB = 20;

  function validate(file) {
    if (!file) return "No file selected.";
    const isImage = file.type.startsWith("image/");
    if (!isImage && !ACCEPTED[file.type]) return "Unsupported file type: " + (file.type || "unknown");
    if (file.size > MAX_SIZE_MB * 1024 * 1024) return "File too large. Max " + MAX_SIZE_MB + "MB.";
    return null;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function showPreview(file) {
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatSize(file.size);
    filePreview.classList.remove("hidden");
    processBtn.disabled = false;
  }

  function hidePreview() {
    selectedFile = null;
    filePreview.classList.add("hidden");
    processBtn.disabled = true;
    fileInput.value = "";
  }

  function readTxt(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(new Error("Failed to read text file.")); };
      reader.readAsText(file);
    });
  }

  async function readPdf(file) {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      fullText += content.items.map(function (item) { return item.str; }).join(" ") + "\n\n";
    }
    return fullText;
  }

  async function readDocx(file) {
    const buffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml").async("string");
    return xml
      .replace(/<w:p[^>]*>/g, "\n")
      .replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  async function extractText(file) {
    const type = file.type;
    if (type === "text/plain") return readTxt(file);
    if (type === "application/pdf") return readPdf(file);
    if (type.includes("word")) return readDocx(file);
    if (type.startsWith("image/")) return OcrModule.runOnFile(file);
    throw new Error("Unsupported file type for extraction.");
  }

  function handleChosen(file) {
    const error = validate(file);
    if (error) {
      Toast.show(error, "error");
      hidePreview();
      return;
    }
    showPreview(file);
  }

  function init(onProcess) {
    const idleLabel = processBtn.textContent;

    fileInput.addEventListener("change", function (e) { handleChosen(e.target.files[0]); });

    ["dragenter", "dragover"].forEach(function (name) {
      dropZone.addEventListener(name, function (e) { e.preventDefault(); dropZone.classList.add("dragover"); });
    });
    ["dragleave", "drop"].forEach(function (name) {
      dropZone.addEventListener(name, function (e) { e.preventDefault(); dropZone.classList.remove("dragover"); });
    });
    dropZone.addEventListener("drop", function (e) { handleChosen(e.dataTransfer.files[0]); });

    removeBtn.addEventListener("click", hidePreview);

    processBtn.addEventListener("click", async function () {
      if (!selectedFile) return;
      processBtn.disabled = true;
      processBtn.textContent = "Extracting\u2026";
      try {
        const raw = await extractText(selectedFile);
        if (!raw || !raw.trim()) throw new Error("No readable text found in file.");
        onProcess(raw, "file-upload");
        hidePreview();
      } catch (err) {
        console.error(err);
        Toast.show(err.message || "Extraction failed.", "error");
      } finally {
        processBtn.disabled = !selectedFile;
        processBtn.textContent = idleLabel;
      }
    });
  }

  return { init, reset: hidePreview };
})();

const OcrModule = (() => {
  const imageInput = $("#imageInput");
  const cameraBtn = $("#cameraBtn");
  const captureBtn = $("#captureBtn");
  const video = $("#cameraStream");
  const imagePreview = $("#imagePreview");
  const imagePreviewWrap = $("#imagePreviewWrap");
  const runOcrBtn = $("#runOcrBtn");
  const progressWrap = $("#ocrProgress");
  const progressFill = $("#progressFill");
  const progressText = $("#progressText");

  let currentImageFile = null;
  let mediaStream = null;

  function setProgress(percent, message) {
    progressWrap.classList.remove("hidden");
    progressFill.style.width = percent + "%";
    progressText.textContent = message;
  }

  function hideProgress() {
    setTimeout(function () { progressWrap.classList.add("hidden"); }, 1200);
  }

  function handleImageFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      Toast.show("Please select a valid image.", "error");
      return;
    }
    currentImageFile = file;
    imagePreview.src = URL.createObjectURL(file);
    imagePreviewWrap.classList.remove("hidden");
    runOcrBtn.disabled = false;
  }

  async function startCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = mediaStream;
      video.classList.remove("hidden");
      captureBtn.classList.remove("hidden");
    } catch (err) {
      console.error(err);
      Toast.show("Camera access denied or unavailable.", "error");
    }
  }

  function stopCamera() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    video.classList.add("hidden");
    captureBtn.classList.add("hidden");
  }

  function capturePhoto() {
    if (!mediaStream) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob(function (blob) {
      handleImageFile(new File([blob], "capture.png", { type: "image/png" }));
      stopCamera();
    }, "image/png");
  }

  async function runOcr(file) {
    if (!window.Tesseract) throw new Error("The scanner could not load. Check your internet connection.");
    setProgress(0, "Loading the scanner\u2026");
    const result = await Tesseract.recognize(file, "eng", {
      logger: function (m) {
        if (m.status === "recognizing text") {
          const percent = Math.round((m.progress || 0) * 100);
          setProgress(percent, "Reading the photo\u2026 " + percent + "%");
        } else {
          setProgress(0, m.status);
        }
      }
    });
    setProgress(100, "Done!");
    hideProgress();
    return result.data.text;
  }

  function runOnFile(file) {
    return runOcr(file);
  }

  function reset() {
    stopCamera();
    currentImageFile = null;
    imagePreviewWrap.classList.add("hidden");
    runOcrBtn.disabled = true;
    progressWrap.classList.add("hidden");
  }

  function init(onProcess) {
    imageInput.addEventListener("change", function (e) { handleImageFile(e.target.files[0]); });
    cameraBtn.addEventListener("click", startCamera);
    captureBtn.addEventListener("click", capturePhoto);

    runOcrBtn.addEventListener("click", async function () {
      if (!currentImageFile) return;
      runOcrBtn.disabled = true;
      try {
        const raw = await runOcr(currentImageFile);
        if (!raw || !raw.trim()) throw new Error("No text detected in the image.");
        onProcess(raw, "ocr");
      } catch (err) {
        console.error(err);
        Toast.show(err.message || "Scanning failed.", "error");
      } finally {
        runOcrBtn.disabled = !currentImageFile;
      }
    });
  }

  return { init, runOnFile, reset };
})();

const TextInputModule = (() => {
  const textarea = $("#textInput");
  const titleInput = $("#titleInput");
  const charCount = $("#charCount");
  const clearBtn = $("#clearTextBtn");
  const processBtn = $("#processTextBtn");

  function updateCharCount() {
    charCount.textContent = textarea.value.length;
  }

  function fill(title, text) {
    titleInput.value = title || "";
    textarea.value = text || "";
    updateCharCount();
  }

  function init(onProcess) {
    textarea.addEventListener("input", updateCharCount);
    clearBtn.addEventListener("click", function () {
      fill(titleInput.value, "");
      textarea.focus();
    });
    processBtn.addEventListener("click", function () {
      const text = textarea.value.trim();
      if (!text) {
        Toast.show("Please enter some text first.", "error");
        return;
      }
      onProcess(text, "text-input");
    });
    updateCharCount();
  }

  return { init, fill };
})();

// The pop-up window used to add a new passage or edit an existing one
const AddDialog = (() => {
  const dialog = $("#addDialog");
  let editingId = null;

  function setTab(name) {
    $$(".tab", dialog).forEach(function (tab) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".tab-panel", dialog).forEach(function (panel) {
      panel.classList.toggle("hidden", panel.dataset.panel !== name);
    });
  }

  // options: { mode: "new" | "edit", id, title, text }
  function open(options) {
    const editing = options.mode === "edit";
    editingId = editing ? options.id : null;
    $("#dialogTitle").textContent = editing ? "Edit passage" : "New passage";
    $("#processTextBtn").textContent = editing ? "Save changes" : "Add to library";
    $$(".tab", dialog).forEach(function (tab) {
      if (tab.dataset.tab !== "type") tab.classList.toggle("hidden", editing);
    });
    TextInputModule.fill(options.title, options.text);
    setTab("type");
    if (!dialog.open) dialog.showModal();
    $("#textInput").focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  function init() {
    $$(".tab", dialog).forEach(function (tab) {
      tab.addEventListener("click", function () { setTab(tab.dataset.tab); });
    });
    $("#dialogClose").addEventListener("click", close);
    // click on the dark area outside the window closes it
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) close();
    });
    dialog.addEventListener("close", function () {
      editingId = null;
      OcrModule.reset();
    });
  }

  return { init, open, close, editingId: function () { return editingId; }, isOpen: function () { return dialog.open; } };
})();

// ---------------------------------------------------------------------
// 10. APP - connects everything together and starts it
// ---------------------------------------------------------------------
const App = (() => {
  function openPassage(passage) {
    loadPassageIntoReader(passage);
    Nav.show("reader");
  }

  // Save a brand-new passage on the server, and open it
  function saveAndOpen(text, title) {
    const draft = { id: null, title: title, text: text };
    openPassage(draft);
    Library.create(text, title)
      .then(function (saved) {
        draft.id = saved.id; // now Edit works for this passage
        return Library.refresh();
      })
      .catch(function () {
        Toast.show("Could not save to the server.", "error");
      });
  }

  // Called by the type, upload and scan tabs when text is ready
  function handleProcessedText(raw, source) {
    const cleaned = TextCleaner.clean(raw);
    if (!cleaned) {
      Toast.show("That text was empty after cleaning.", "error");
      return;
    }
    const typedTitle = source === "text-input" ? $("#titleInput").value.trim() : "";
    const editing = AddDialog.editingId();
    AddDialog.close();
    TextInputModule.fill("", "");
    FileUploadModule.reset();

    if (editing !== null) {
      const title = typedTitle || (currentPassage ? currentPassage.title : makeTitle(cleaned));
      openPassage({ id: editing, title: title, text: cleaned });
      Library.update(editing, cleaned, typedTitle)
        .then(Library.refresh)
        .catch(function () { Toast.show("Could not update the passage.", "error"); });
      Toast.show("Passage updated", "success");
    } else {
      saveAndOpen(cleaned, typedTitle || makeTitle(cleaned));
      Toast.show("Passage added", "success");
    }
  }

  function startEditing() {
    if (!currentPassage) return;
    if (currentPassage.id === null) {
      Toast.show("Still saving this passage. Try again in a moment.", "info");
      return;
    }
    AddDialog.open({ mode: "edit", id: currentPassage.id, title: currentPassage.title, text: currentPassage.text });
  }

  function init() {
    SettingsModule.init();
    RulerModule.init();
    Nav.init();
    initReadAloud();
    WordHelper.init();
    InsightsView.init();
    AddDialog.init();

    TextInputModule.init(handleProcessedText);
    FileUploadModule.init(handleProcessedText);
    OcrModule.init(handleProcessedText);
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    $("#editPassageBtn").addEventListener("click", startEditing);
    Library.init();
  }

  return { init, openPassage, saveAndOpen };
})();

App.init();
