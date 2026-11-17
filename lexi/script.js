// =====================================================================
// LEXI - script.js
//
//   1. Helpers            small tools used everywhere (storage, toast, server calls)
//   2. Cloud sync         keeps your settings and progress on your account
//   3. Accounts           sign in, create account, auto sign-out
//   4. Settings, ruler, navigation
//   5. Languages          English and French: detection, syllables, common words
//   6. Read aloud         voices, translation, highlighting, play/pause
//   7. Word bank + word card  tap a word: hear it, syllables, meaning
//   8. Stats and reading checks data
//   9. Tricky words       warm-up list for each passage
//  10. Read to Lexi       listens to you read and marks every word
//  11. Word Coach         practice games with a review schedule
//  12. Find my best settings   the reading test
//  13. Insights, Library, add-passage tools
//  14. Sharing            private progress link for a teacher or parent
//  15. App                connects everything and starts it
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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
  return words.length > 6 ? short + "…" : short;
}

function icon(name) {
  return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
  }
  return copy;
}

function langTag(lang) {
  return lang === "fr" ? "fr-FR" : "en-US";
}

// A word without punctuation at its ends, lower case: "Dyslexia," -> "dyslexia"
function normaliseWord(raw) {
  return raw.toLowerCase().replace(/[’]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function needOnline(message) {
  if (navigator.onLine === false) {
    Toast.show(message || "You are offline. Connect to the internet to do this.", "error");
    return false;
  }
  return true;
}

// These browser-storage keys are also saved on the account (the server calls them settings, stats, ...)
const SYNC_KEYS = {
  "lexi.settings.v1": "settings",
  "lexi.stats.v1": "stats",
  "lexi.words.v1": "words",
  "lexi.reads.v1": "reads",
  "lexi.calib.v1": "calib"
};

// Store: read and write small pieces of data in the browser (never crashes)
const Store = (() => {
  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }
  // rawWrite saves on this device only
  function rawWrite(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage is blocked or full: the app still works, it just won't remember */
    }
  }
  // write saves on this device and (for the keys above) on the account
  function write(key, value) {
    rawWrite(key, value);
    if (SYNC_KEYS[key]) Cloud.queue(SYNC_KEYS[key]);
  }
  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  return { read, rawWrite, write, remove };
})();

// Toast: the small message that pops up at the bottom
const Toast = (() => {
  const node = $("#toast");
  let timer = null;
  function show(message, type = "info") {
    if (!node) return;
    node.textContent = message;
    node.className = "toast show " + type;
    clearTimeout(timer);
    timer = setTimeout(() => node.classList.remove("show"), 3400);
  }
  return { show };
})();

// Api: every call to the server goes through here
const Api = (() => {
  async function request(path, method, body) {
    const options = { method: method, headers: { "X-Lexi": "1" }, credentials: "same-origin" };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch(API_URL + path, options);
    } catch (e) {
      const offline = new Error("You appear to be offline.");
      offline.offline = true;
      throw offline;
    }
    let data = null;
    try { data = await response.json(); } catch (e) { /* no body */ }
    if (!response.ok) {
      const error = new Error((data && data.error) || "Server said " + response.status);
      error.status = response.status;
      error.code = data && data.code;
      const signInCall = path.indexOf("/api/auth/") === 0;
      if (response.status === 401 && !signInCall) Session.expired(error.code);
      throw error;
    }
    return data;
  }
  return {
    get: function (path) { return request(path, "GET"); },
    post: function (path, body) { return request(path, "POST", body === undefined ? {} : body); },
    put: function (path, body) { return request(path, "PUT", body); },
    del: function (path) { return request(path, "DELETE"); }
  };
})();

// ---------------------------------------------------------------------
// 2. CLOUD SYNC (settings, stats, words, reading checks follow your account)
// ---------------------------------------------------------------------
const Cloud = (() => {
  const DIRTY = "lexi.dirty";       // names of things changed here that the server has not got yet
  const NAME_TO_KEY = {};
  Object.keys(SYNC_KEYS).forEach(function (key) { NAME_TO_KEY[SYNC_KEYS[key]] = key; });
  let enabled = false;
  let timer = null;
  let flushing = false;

  function dirtySet() { return new Set(Store.read(DIRTY, [])); }
  function saveDirty(set) { Store.rawWrite(DIRTY, Array.from(set)); }

  function queue(name) {
    const dirty = dirtySet();
    dirty.add(name);
    saveDirty(dirty);
    if (enabled) {
      clearTimeout(timer);
      timer = setTimeout(flush, 1500);
    }
  }

  async function flush() {
    if (!enabled || flushing) return;
    flushing = true;
    let again = false;
    try {
      const names = Array.from(dirtySet());
      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const key = NAME_TO_KEY[name];
        const value = Store.read(key, null);
        if (value === null) {
          const d = dirtySet(); d.delete(name); saveDirty(d);
          continue;
        }
        const sent = JSON.stringify(value);
        try {
          await Api.put("/api/data/" + name, { value: value });
          // Only forget it if it did not change while we were sending
          if (JSON.stringify(Store.read(key, null)) === sent) {
            const d = dirtySet(); d.delete(name); saveDirty(d);
          } else {
            again = true;
          }
        } catch (e) {
          if (e.offline || e.status === 401) break;
        }
      }
    } finally {
      flushing = false;
    }
    if (again) queue("settings");
  }

  // At sign-in: take the account's data, unless this device has changes not uploaded yet
  async function pull() {
    const result = await Api.get("/api/data");
    const server = (result && result.data) || {};
    const dirty = dirtySet();
    Object.keys(NAME_TO_KEY).forEach(function (name) {
      const key = NAME_TO_KEY[name];
      if (dirty.has(name)) return;
      if (server[name] !== undefined) {
        Store.rawWrite(key, server[name]);
      } else if (localStorage.getItem(key) !== null) {
        queue(name); // the account has nothing yet: upload what this device has
      }
    });
  }

  function enable() { enabled = true; flush(); }
  function disable() { enabled = false; clearTimeout(timer); }

  // Remove everything of this account from this device (used when signing out)
  function wipeLocal() {
    Object.keys(SYNC_KEYS).forEach(Store.remove);
    [DIRTY, "lexi.cache.passages", "lexi.session", "lexi.owner", "lexi.signedIn"].forEach(Store.remove);
  }

  return { queue, flush, pull, enable, disable, wipeLocal };
})();

// ---------------------------------------------------------------------
// 3. ACCOUNTS
// ---------------------------------------------------------------------
const Session = (() => {
  let user = null;
  let remember = false;
  let idleMinutes = 120;
  let offline = false;
  let lastActivity = Date.now();
  let lastPing = Date.now();
  let watching = false;

  function hideSplash() {
    const splash = $("#splash");
    if (splash) splash.classList.add("hidden");
  }

  async function start() {
    const shareCode = new URLSearchParams(location.search).get("share");
    if (shareCode) {
      hideSplash();
      ShareView.open(shareCode);
      return;
    }

    let notice = "";
    try {
      notice = sessionStorage.getItem("lexi.notice") || "";
      sessionStorage.removeItem("lexi.notice");
    } catch (e) { /* ignore */ }

    try {
      const me = await Api.get("/api/auth/me");
      await signedIn(me);
    } catch (e) {
      if (e.offline) {
        const cached = Store.read("lexi.session", null);
        if (cached && cached.id) {
          offline = true;
          user = cached;
          await enterApp();
        } else {
          AuthUI.show({ notice: "You are offline. Connect to the internet to sign in." });
        }
      } else if (e.status && e.status >= 500) {
        AuthUI.show({ notice: "Lexi's server is waking up. Wait a moment and try again." });
      } else {
        const wasSignedIn = Store.read("lexi.signedIn", false);
        AuthUI.show({
          notice: notice || (wasSignedIn ? "You were signed out because you were away for a while." : "")
        });
      }
    }
    hideSplash();
  }

  async function signedIn(me) {
    user = me.user;
    remember = !!me.remember;
    idleMinutes = me.idleMinutes || 120;
    offline = false;

    // A different person on this device? Remove the previous person's data first.
    const owner = Store.read("lexi.owner", null);
    if (owner !== null && owner !== user.id) Cloud.wipeLocal();
    Store.rawWrite("lexi.owner", user.id);
    Store.rawWrite("lexi.session", user);
    Store.rawWrite("lexi.signedIn", true);

    Cloud.enable();
    try { await Cloud.pull(); } catch (e) { /* offline or busy: use what this device has */ }
    await enterApp();
    Cloud.flush();
  }

  async function enterApp() {
    AuthUI.hide();
    $("#appShell").classList.remove("hidden");
    App.onSignedIn(user, { offline: offline, remember: remember });
    startWatchers();
  }

  // ----- signing out after a long time without use -----
  function bump() { lastActivity = Date.now(); }

  function startWatchers() {
    if (watching) return;
    watching = true;
    ["pointerdown", "keydown", "touchstart", "scroll", "mousemove"].forEach(function (name) {
      window.addEventListener(name, bump, { passive: true });
    });
    setInterval(tick, 60 * 1000);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
  }

  async function tick() {
    if (!user || offline) return;
    const idleMs = Date.now() - lastActivity;
    if (!remember && idleMs > idleMinutes * 60 * 1000) {
      signOut({ reason: "idle" });
      return;
    }
    // While you are active, tell the server now and then so it keeps you signed in
    if (Date.now() - lastPing > 10 * 60 * 1000 && idleMs < 10 * 60 * 1000) {
      lastPing = Date.now();
      try { await Api.post("/api/auth/ping"); } catch (e) { /* ignore */ }
    }
  }

  async function signOut(options) {
    try { await Cloud.flush(); } catch (e) { /* ignore */ }
    try { await Api.post("/api/auth/logout"); } catch (e) { /* ignore */ }
    Cloud.disable();
    Cloud.wipeLocal();
    if (options && options.reason === "idle") {
      try { sessionStorage.setItem("lexi.notice", "You were signed out because you were away for a while."); } catch (e) { /* ignore */ }
    }
    location.reload();
  }

  // The server said "please sign in" in the middle of using the app
  function expired(code) {
    if (!user) return;
    user = null;
    Cloud.disable();
    $("#appShell").classList.add("hidden");
    AuthUI.show({
      notice: code === "expired" ? "You were signed out because you were away for a while." : "Please sign in again."
    });
  }

  return { start, signedIn, signOut, expired, get user() { return user; }, get remember() { return remember; }, hideSplash };
})();

const AuthUI = (() => {
  const screen = $("#authScreen");
  const form = $("#authForm");
  const errorBox = $("#authError");
  const notice = $("#authNotice");
  const submit = $("#authSubmit");
  let mode = "login";
  let busy = false;

  function setMode(next) {
    mode = next;
    const registering = mode === "register";
    $$("#authTabs button").forEach(function (button) {
      const on = button.dataset.mode === mode;
      button.classList.toggle("selected", on);
      button.setAttribute("aria-checked", on ? "true" : "false");
    });
    $("#authTitle").textContent = registering ? "Create your account" : "Welcome back";
    $("#authSub").textContent = registering
      ? "It takes a minute. Your passages and progress will be saved."
      : "Sign in to open your passages and progress.";
    $("#authNameRow").classList.toggle("hidden", !registering);
    $("#authPwHint").classList.toggle("hidden", !registering);
    $("#authPassword").setAttribute("autocomplete", registering ? "new-password" : "current-password");
    submit.textContent = registering ? "Create account" : "Sign in";
    errorBox.textContent = "";
  }

  function show(options) {
    const message = options && options.notice;
    notice.textContent = message || "";
    notice.classList.toggle("hidden", !message);
    screen.classList.remove("hidden");
    $("#appShell").classList.add("hidden");
    Session.hideSplash();
    setTimeout(function () { $("#authEmail").focus(); }, 50);
  }

  function hide() {
    screen.classList.add("hidden");
    $("#authPassword").value = "";
  }

  function validate(name, email, password) {
    if (mode === "register" && !name) return "Please enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Please enter a valid email address.";
    if (!password) return "Please enter your password.";
    if (mode === "register" && password.length < 8) return "Your password must have at least 8 characters.";
    return "";
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const name = $("#authName").value.trim();
    const email = $("#authEmail").value.trim();
    const password = $("#authPassword").value;
    const problem = validate(name, email, password);
    if (problem) { errorBox.textContent = problem; return; }

    busy = true;
    submit.disabled = true;
    errorBox.textContent = "";
    try {
      const body = { email: email, password: password, remember: $("#authRemember").checked };
      if (mode === "register") body.name = name;
      const me = await Api.post(mode === "register" ? "/api/auth/register" : "/api/auth/login", body);
      await Session.signedIn(me);
    } catch (e) {
      errorBox.textContent = e.message || "Something went wrong. Please try again.";
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  function init() {
    $$("#authTabs button").forEach(function (button) {
      button.addEventListener("click", function () { setMode(button.dataset.mode); });
    });
    form.addEventListener("submit", onSubmit);
    $("#authShowPw").addEventListener("click", function () {
      const input = $("#authPassword");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      this.textContent = showing ? "Show" : "Hide";
      this.setAttribute("aria-pressed", showing ? "false" : "true");
    });
    setMode("login");
  }

  return { init, show, hide };
})();

// ---------------------------------------------------------------------
// 4. SETTINGS, READING RULER, NAVIGATION
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
    voice: "",
    markTricky: false
  };

  let values = Object.assign({}, DEFAULTS, Store.read(KEY, {}));

  function get(key) { return values[key]; }

  function set(key, value) {
    values[key] = value;
    Store.write(KEY, values);
    apply();
  }

  function setMany(changes) {
    Object.assign(values, changes);
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
    $$("[data-setting]").forEach(function (node) {
      const key = node.dataset.setting;
      if (node.matches("input, select")) {
        if (node.value !== String(values[key])) node.value = values[key];
      } else {
        $$("button", node).forEach(function (button) {
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
    TrickyWords.decorate();
  }

  function reload() {
    values = Object.assign({}, DEFAULTS, Store.read(KEY, {}));
    apply();
  }

  function reset() {
    const keepVoice = values.voice;
    values = Object.assign({}, DEFAULTS, { voice: keepVoice });
    Store.write(KEY, values);
    apply();
  }

  function init() {
    // sliders and drop-downs
    $$("input[data-setting], select[data-setting]").forEach(function (node) {
      node.addEventListener("input", function () {
        set(node.dataset.setting, node.type === "range" ? Number(node.value) : node.value);
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

  return { init, get, set, setMany, reload };
})();

// Reading ruler (band = highlight one strip, focus = dim everything else)
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
  function followElement(node) {
    const rect = node.getBoundingClientRect();
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

// Navigation (five screens: library, reader, practice, insights, settings)
const Nav = (() => {
  function show(id) {
    if (id !== "reader") {
      resetAudio(); // stop speaking when leaving the reader
      ReadAlong.close();
    }
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
    if (id === "practice") Coach.refresh();
    if (id === "reader") RulerModule.position();
  }

  function init() {
    $$(".nav-item").forEach(function (button) {
      button.addEventListener("click", function () { show(button.dataset.screen); });
    });
    $("#backBtn").addEventListener("click", function () { show("library"); });
    $("#goLibraryBtn").addEventListener("click", function () { show("library"); });
    $("#accountChip").addEventListener("click", function () { show("settings"); });
  }

  return { init, show };
})();

// ---------------------------------------------------------------------
// 5. LANGUAGES (English and French)
// ---------------------------------------------------------------------
const Lang = (() => {
  const EN_COMMON = new Set((
    "the of and to in is it you that he was for on are with as his they be at one have this from or had by but what some " +
    "we can out other were all there when up use your how said an each she which do their time if will way about many then " +
    "them would like so these her long make thing see him two has look more day could go come did no most my over know water " +
    "than call first who may down been now find any new work part take get place made live where after back little only round " +
    "man year came show every good give our under name very through just form great think say help low line turn much mean " +
    "before move right boy old too same tell does set three want air well also play small end put home read hand large even " +
    "land here must big high such follow act why ask men change went light kind off need house try again point mother world " +
    "near build self earth father head stand own page should country found answer school grow study still learn plant cover " +
    "food sun four between state keep never last let city tree cross farm hard start story saw far sea draw left late run " +
    "while press close night real life few open seem together next white children begin got walk example ease paper group " +
    "always those both often until mile river car feet care second book took room friend idea fish stop once base hear horse " +
    "cut sure watch face wood main enough girl young ready above ever red list though feel talk bird soon body dog family " +
    "leave song door black short class wind question happen ship half rock order fire problem piece told knew pass since top " +
    "whole king space heard best hour better during five step early hold west ground reach fast sing listen six table less " +
    "morning ten simple several toward war lay against slow love person money serve road rain pull cold voice fall lead " +
    "dark note wait plan star box field rest able done front week green quick warm free strong clear full blue deep moon " +
    "foot busy test boat dry game heat snow bring yes fill east paint among because people water through again"
  ).split(/\s+/));

  const FR_COMMON = new Set((
    "le la les un une des du de et est en que qui dans pour pas sur au aux avec ce cet cette ces il elle nous vous ils elles " +
    "je tu me te se ne son sa ses mon ma mes ton ta tes leur leurs plus mais ou donc car si comme tout tous toute toutes " +
    "tres bien etre avoir faire dit fait peut aussi autre autres meme sans sous entre vers chez depuis alors encore jamais " +
    "toujours deja puis ainsi parce quand lorsque quel quelle quels quelles par ici la oui non merci bonjour jour nuit " +
    "homme femme enfant maison ville eau pain petit grand beau bon mauvais nouveau vieux jeune premier dernier deux trois " +
    "quatre cinq six sept huit neuf dix cent mille annee temps monde vie main tete yeux pere mere ami moi toi lui eux elle " +
    "ete sont etait avait sera aura faut veut voir dire aller venir prendre donner savoir pouvoir vouloir devoir mettre " +
    "parler passer trouver rester lire ecrire manger boire dormir jouer"
  ).split(/\s+/));

  const EN_MARK = new Set("the and is are was that with for this of to in it you have not on be as at by from".split(" "));
  const FR_MARK = new Set(
    "le la les des est une un que pour dans avec sur pas qui nous vous sont cette ce et en du au aux se ne son ses mais ou où plus très être avoir il elle ils elles je tu".split(" ")
  );

  // Guess the language of a passage from very common words and accents
  function detect(text) {
    const words = (text.toLowerCase().match(/[\p{L}']+/gu) || []).slice(0, 400);
    let en = 0;
    let fr = 0;
    words.forEach(function (w) {
      if (EN_MARK.has(w)) en++;
      if (FR_MARK.has(w)) fr++;
    });
    const accents = (text.slice(0, 2000).match(/[éèêëàâçîïôùûœ]/gi) || []).length;
    fr += Math.min(accents, 20) / 4;
    return fr > en * 1.2 && fr >= 3 ? "fr" : "en";
  }

  function isCommon(word, lang) {
    const plain = lang === "fr" ? word.normalize("NFD").replace(/[̀-ͯ]/g, "") : word;
    return (lang === "fr" ? FR_COMMON : EN_COMMON).has(plain);
  }

  // ---- splitting a word into syllables (an approximation) ----
  const EN_DIGRAPHS = ["th", "sh", "ch", "ph", "wh", "ck", "ng", "gh"];

  function syllabifyEn(word) {
    if (/[^A-Za-z]/.test(word)) return [word];
    const w = word.toLowerCase();
    if (w.length < 4) return [word];

    // words ending in -ing: split the stem, then add "ing" (read-ing, run-ning)
    if (/ing$/.test(w) && w.length >= 6 && /[aeiouy]/.test(w.slice(0, -3))) {
      let stem = word.slice(0, -3);
      let tail = "ing";
      const doubled = /([^aeiouy])\1$/.test(stem.toLowerCase());
      if (doubled) { stem = stem.slice(0, -1); tail = word.slice(-4); }
      return syllabifyEn(stem).concat([tail]);
    }

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
      cuts.push(w.length - 3);
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
        cuts.push(between === "x" ? gapStart + 1 : gapStart);
      } else if (between.length >= 2) {
        if (between.length === 2 && EN_DIGRAPHS.includes(between)) cuts.push(gapStart);
        else cuts.push(gapStart + 1);
      }
    }

    return cutWord(word, cuts.concat(inner), w.length);
  }

  const FR_ONSETS = ["pl", "pr", "bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "tr", "vr", "ch", "ph", "th", "gn"];

  function syllabifyFr(word) {
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿŒœÆæ]+$/.test(word)) return [word];
    const w = word.toLowerCase();
    if (w.length < 4) return [word];
    const vowels = "aeiouyàâäéèêëîïôöùûüœæ";

    const nuclei = [];
    let i = 0;
    while (i < w.length) {
      if (vowels.includes(w[i])) {
        let j = i;
        while (j + 1 < w.length && vowels.includes(w[j + 1])) j++;
        nuclei.push({ start: i, end: j });
        i = j + 1;
      } else {
        i++;
      }
    }
    if (nuclei.length < 2) return [word];

    const cuts = [];
    for (let k = 0; k < nuclei.length - 1; k++) {
      const gapStart = nuclei[k].end + 1;
      const gapEnd = nuclei[k + 1].start;
      const between = w.slice(gapStart, gapEnd);
      if (between.length === 1) {
        cuts.push(gapStart);                                  // ma-ri
      } else if (between.length >= 2) {
        const lastTwo = between.slice(-2);
        cuts.push(FR_ONSETS.includes(lastTwo) ? gapEnd - 2 : gapEnd - 1); // ta-ble, por-te, ins-tru-ment
      }
    }
    return cutWord(word, cuts, w.length);
  }

  function cutWord(word, cuts, length) {
    const sorted = cuts
      .filter(function (c) { return c > 0 && c < length; })
      .sort(function (a, b) { return a - b; })
      .filter(function (c, idx, arr) { return idx === 0 || c !== arr[idx - 1]; });
    const parts = [];
    let from = 0;
    sorted.forEach(function (c) {
      parts.push(word.slice(from, c));
      from = c;
    });
    parts.push(word.slice(from));
    return parts.filter(Boolean);
  }

  function syllabify(word, lang) {
    const apostrophe = Math.max(word.lastIndexOf("'"), word.lastIndexOf("’"));
    if (apostrophe >= 0) {
      if (lang !== "fr") return [word];
      const parts = syllabifyFr(word.slice(apostrophe + 1));
      parts[0] = word.slice(0, apostrophe + 1) + parts[0];
      return parts;
    }
    return lang === "fr" ? syllabifyFr(word) : syllabifyEn(word);
  }

  return { detect, isCommon, syllabify };
})();

// ---------------------------------------------------------------------
// 6. READ ALOUD (browser voice) with word highlighting, pause/resume and
//    automatic translation
// ---------------------------------------------------------------------
const TTS_SUPPORTED = !!window.speechSynthesis;
const synth = window.speechSynthesis || {
  getVoices() { return []; },
  cancel() {},
  speak() {},
  addEventListener() {}
};

const playPauseBtn = $("#playPauseBtn");
const stopBtn = $("#stopBtn");
const speedControl = $("#speedControl");
const voiceControl = $("#voiceControl");
const readingText = $("#readingText");
const readProgress = $("#readProgress");

const LANGUAGE_NAMES = { en: "English", fr: "French" };
const LANGUAGE_LABELS = { en: "English", fr: "Français" };

let currentPassage = null;  // { id, title, text } - the passage open in the reader
let passageLang = "en";     // the language the open passage is written in

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
    fr: { label: "Français", preferred: ["Denise", "Henri"] }
  };

  let chosenVoices = [];
  Object.keys(languages).forEach(function (code) {
    const ofLanguage = allVoices.filter(function (v) { return v.lang.toLowerCase().startsWith(code); });
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
  autoPickVoice();
}

function getSelectedVoice() {
  return synth.getVoices().find(function (v) { return v.name === voiceControl.value; }) || null;
}

function voiceLang(voice) {
  return voice ? voice.lang.slice(0, 2).toLowerCase() : null;
}

// The language we will speak: the chosen voice's language, or the passage language
function getSelectedLanguage() {
  return voiceLang(getSelectedVoice()) || passageLang;
}

// A voice that speaks `lang` (the chosen voice if it fits, else a good match)
function voiceForLang(lang) {
  const selected = getSelectedVoice();
  if (selected && voiceLang(selected) === lang) return selected;
  const all = synth.getVoices().filter(function (v) { return v.lang.toLowerCase().startsWith(lang); });
  const preferred = lang === "fr" ? ["Denise", "Henri"] : ["Aria", "Guy"];
  for (let i = 0; i < preferred.length; i++) {
    const match = all.find(function (v) { return v.name.includes(preferred[i]); });
    if (match) return match;
  }
  return all[0] || null;
}

// When a passage opens, switch to a voice that speaks the passage's language
function autoPickVoice() {
  const selected = getSelectedVoice();
  if (selected && voiceLang(selected) === passageLang) return;
  const match = Array.from(voiceControl.options).find(function (option) {
    const voice = synth.getVoices().find(function (v) { return v.name === option.value; });
    return voice && voiceLang(voice) === passageLang;
  });
  voiceControl.value = match ? match.value : "";
}

// ---------- translation ----------
// 1) the translator built into newer Edge/Chrome  2) the free MyMemory service
// 3) if both fail, the original text is read instead
let originalText = null;
let displayedLang = "en";
let displayedText = "";
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
  const options = { sourceLanguage: passageLang, targetLanguage: target };
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
        encodeURIComponent(chunk) + "&langpair=" + passageLang + "|" + target;
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
  const key = passageLang + ">" + target + "|" + text;
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
  displayedLang = passageLang;
  setStatus("");
}

// Shows (and returns) the text that matches the chosen voice's language
async function showTextForCurrentVoice() {
  const token = ++viewToken;
  const target = getSelectedLanguage();

  if (target === passageLang) {
    showOriginal();
    return originalText;
  }

  setStatus("Translating…");
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
function setPassageLanguage(lang) {
  passageLang = lang;
  displayedLang = lang;
  $("#langLabel").textContent = LANGUAGE_LABELS[lang];
  autoPickVoice();
}

function loadPassageIntoReader(passage) {
  resetAudio();
  ReadAlong.close();
  currentPassage = passage;
  originalText = passage.text;
  viewToken++;
  setStatus("");
  setPassageLanguage(Lang.detect(passage.text));
  renderWordSpans(passage.text);
  TrickyWords.refresh();

  const words = countWords(passage.text);
  const minutes = Math.max(1, Math.round(words / 150));
  $("#readingTitle").textContent = passage.title || "Your passage";
  $("#readingMeta").textContent = words + " words · about " + minutes + " min read aloud";
  $("#readerEmpty").classList.add("hidden");
  $("#readerBody").classList.remove("hidden");
}

function showReaderEmpty() {
  resetAudio();
  ReadAlong.close();
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
  displayedText = text;
  currentHighlighted = null;
  TrickyWords.decorate();
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

function keepInView(node) {
  const rect = node.getBoundingClientRect();
  if (rect.top < 100 || rect.bottom > window.innerHeight - 100) {
    const instant = prefersReducedMotion || SettingsModule.get("ruler") !== "off";
    node.scrollIntoView({ block: "center", behavior: instant ? "auto" : "smooth" });
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
  utterance.lang = langTag(getSelectedLanguage());

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
  ReadAlong.stop(true); // Lexi cannot listen and speak at the same time

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

  // Switch the passage's language (English <-> French) if Lexi guessed wrong
  $("#langBtn").addEventListener("click", function () {
    if (!currentPassage) return;
    resetAudio();
    ReadAlong.close();
    setPassageLanguage(passageLang === "en" ? "fr" : "en");
    renderWordSpans(originalText);
    TrickyWords.refresh();
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
    if ($("#addDialog").open || $("#calibDialog").open) return;
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(tag)) return;
    e.preventDefault();
    onPlayPause();
  });

  window.addEventListener("pagehide", stopTimer);
}

// ---------------------------------------------------------------------
// 7. WORD BANK (your practice words) + WORD CARD (tap a word)
// ---------------------------------------------------------------------
const WordBank = (() => {
  const KEY = "lexi.words.v1";
  const DAY = 24 * 60 * 60 * 1000;
  // Review schedule: after a right answer the word comes back later and later
  const GAP_DAYS = { 2: 1, 3: 3, 4: 7, 5: 14 };
  let words = Store.read(KEY, {});

  function reload() { words = Store.read(KEY, {}); }
  function save() { Store.write(KEY, words); }

  function ensure(word, lang) {
    const key = normaliseWord(word);
    if (!key) return null;
    if (!words[key]) {
      words[key] = { count: 0, last: 0, box: 1, due: 0, ok: 0, bad: 0, lang: lang || "en" };
    }
    const entry = words[key];
    if (entry.box === undefined) { entry.box = 1; entry.due = 0; entry.ok = 0; entry.bad = 0; }
    if (!entry.lang) entry.lang = lang || "en";
    return entry;
  }

  function get(word) { return words[normaliseWord(word)] || null; }

  // The word was tapped while reading
  function lookup(word, lang) {
    const entry = ensure(word, lang);
    if (!entry) return null;
    entry.count += 1;
    entry.last = Date.now();
    save();
    return entry;
  }

  function add(word, lang) {
    const key = normaliseWord(word);
    if (!key) return false;
    const existed = !!words[key];
    ensure(key, lang);
    save();
    return !existed;
  }

  // A word was misread in "Read to Lexi": practise it soon
  function noteMissed(word, lang) {
    const entry = ensure(word, lang);
    if (!entry) return false;
    const isNew = entry.count === 0 && entry.ok === 0 && entry.bad === 0;
    entry.box = 1;
    entry.due = 0;
    entry.bad += 1;
    save();
    return isNew;
  }

  function grade(word, correct) {
    const entry = ensure(word);
    if (!entry) return;
    const now = Date.now();
    if (correct) {
      entry.ok += 1;
      entry.box = Math.min(5, entry.box + 1);
      entry.due = now + GAP_DAYS[entry.box] * DAY;
    } else {
      entry.bad += 1;
      entry.box = 1;
      entry.due = now + 10 * 60 * 1000;
    }
    entry.last = now;
    save();
  }

  function all() {
    return Object.keys(words).map(function (w) {
      const e = ensure(w);
      return Object.assign({ word: w }, e);
    });
  }

  function list() {
    return all().sort(function (a, b) { return b.count - a.count || b.last - a.last; }).slice(0, 40);
  }

  function due() {
    const now = Date.now();
    return all()
      .filter(function (e) { return e.due <= now; })
      .sort(function (a, b) { return a.box - b.box || a.due - b.due; });
  }

  function counts() {
    const list = all();
    const mastered = list.filter(function (e) { return e.box >= 4; }).length;
    return { total: list.length, due: due().length, mastered: mastered, learning: list.length - mastered };
  }

  function remove(word) { delete words[normaliseWord(word)]; save(); }
  function clearAll() { words = {}; save(); }

  return { reload, get, lookup, add, noteMissed, grade, all, list, due, counts, remove, clearAll };
})();

const WordHelper = (() => {
  const card = $("#wordCard");
  const definitionCache = new Map();
  let definitionToken = 0;
  let pickedSpan = null;

  // Remove punctuation from both ends of a tapped word
  function cleanWord(raw) {
    return raw.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  }

  function syllabify(word, lang) {
    return Lang.syllabify(word, lang || displayedLang);
  }

  // ---- speaking ----
  function speakPiece(text, rate, lang) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.lang = langTag(lang);
    const voice = voiceForLang(lang);
    if (voice) utterance.voice = voice;
    synth.speak(utterance);
  }

  function hear(word, lang) {
    if (!TTS_SUPPORTED) { Toast.show("Your browser can't read aloud.", "error"); return; }
    pauseReading();
    synth.cancel();
    speakPiece(word, 0.85, lang || displayedLang);
  }

  function hearBySyllable(word, lang) {
    if (!TTS_SUPPORTED) { Toast.show("Your browser can't read aloud.", "error"); return; }
    const language = lang || displayedLang;
    pauseReading();
    synth.cancel();
    syllabify(word, language).forEach(function (part) { speakPiece(part, 0.6, language); });
    speakPiece(word, 0.85, language);
  }

  // ---- meaning ----
  function stripHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    return (doc.body.textContent || "").trim();
  }

  async function fetchEnglish(key) {
    const response = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(key));
    if (!response.ok) return null;
    const data = await response.json();
    const meanings = [];
    (data[0].meanings || []).slice(0, 2).forEach(function (m) {
      const first = m.definitions && m.definitions[0];
      if (first) meanings.push({ pos: m.partOfSpeech, text: first.definition, example: first.example || "" });
    });
    return meanings;
  }

  // French meanings come from Wiktionary (best effort: if it fails we show a link instead)
  async function fetchFrench(key) {
    const response = await fetch("https://fr.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(key));
    if (!response.ok) return null;
    const data = await response.json();
    const entries = data.fr || data[Object.keys(data)[0]] || [];
    const meanings = [];
    entries.slice(0, 2).forEach(function (entry) {
      const first = entry.definitions && entry.definitions[0];
      if (!first) return;
      const text = stripHtml(first.definition);
      if (text) meanings.push({ pos: entry.partOfSpeech || "", text: text, example: stripHtml(first.examples && first.examples[0]) });
    });
    return meanings;
  }

  async function fetchMeanings(word, lang) {
    const key = word.toLowerCase();
    const cacheKey = lang + "|" + key;
    if (definitionCache.has(cacheKey)) return definitionCache.get(cacheKey);
    const meanings = lang === "fr" ? await fetchFrench(key) : await fetchEnglish(key);
    definitionCache.set(cacheKey, meanings);
    return meanings;
  }

  function lookupLink(box, word, lang) {
    const link = document.createElement("a");
    link.href = "https://" + (lang === "fr" ? "fr" : "en") + ".wiktionary.org/wiki/" + encodeURIComponent(word.toLowerCase());
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Look it up on Wiktionary";
    box.appendChild(document.createTextNode(" "));
    box.appendChild(link);
  }

  async function showDefinition(word, lang) {
    const box = $("#wcDef");
    const token = ++definitionToken;
    box.textContent = "Looking up the meaning…";
    try {
      const meanings = await fetchMeanings(word, lang);
      if (token !== definitionToken) return;
      box.textContent = "";
      if (!meanings || meanings.length === 0) {
        box.textContent = "No meaning found for this word.";
        lookupLink(box, word, lang);
        return;
      }
      meanings.forEach(function (m) {
        const wrap = el("div", "meaning");
        if (m.pos) wrap.appendChild(el("span", "pos", m.pos));
        wrap.appendChild(document.createTextNode(m.text));
        if (m.example) wrap.appendChild(el("div", "example", "“" + m.example + "”"));
        box.appendChild(wrap);
      });
    } catch (e) {
      if (token !== definitionToken) return;
      box.textContent = "Couldn't look up the meaning. Check your internet connection.";
    }
  }

  // ---- the card ----
  function open(rawWord, countIt, language) {
    const lang = language || displayedLang;
    const word = cleanWord(rawWord);
    if (!word) return;

    if (countIt) WordBank.lookup(word, lang);

    const parts = syllabify(word, lang);
    $("#wcWord").textContent = word;
    $("#wcSyll").textContent = parts.length > 1 ? parts.join(" · ") : "1 syllable";
    const entry = WordBank.get(word);
    const times = entry ? entry.count : 0;
    $("#wcCount").textContent = times > 0
      ? "You've looked up this word " + times + (times === 1 ? " time." : " times.")
      : "";

    $("#wcHear").onclick = function () { hear(word, lang); };
    $("#wcSlow").onclick = function () { hearBySyllable(word, lang); };
    $("#wcSlow").classList.toggle("hidden", parts.length < 2);

    card.classList.remove("hidden");
    showDefinition(word, lang);
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

  function init() {
    $("#wcClose").addEventListener("click", close);
  }

  return { init, open, openFromSpan, close, syllabify, hear, hearBySyllable };
})();

// ---------------------------------------------------------------------
// 8. STATS (reading time, words, streak) and READING CHECKS (speed + accuracy)
// ---------------------------------------------------------------------
const StatsModule = (() => {
  const KEY = "lexi.stats.v1";
  let data = load();

  function load() {
    return Object.assign({ totalSeconds: 0, totalWords: 0, completed: 0, days: {} }, Store.read(KEY, {}));
  }
  function reload() { data = load(); }
  function save() {
    // keep only the last 60 days
    const keys = Object.keys(data.days).sort();
    while (keys.length > 60) delete data.days[keys.shift()];
    Store.write(KEY, data);
  }

  function dayKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
  }
  function today() {
    const key = dayKey(new Date());
    if (!data.days[key]) data.days[key] = { s: 0, w: 0, p: 0 };
    return data.days[key];
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
  function addPractice(count) {
    const day = today();
    day.p = (day.p || 0) + count;
    save();
  }
  function addCompletion() {
    data.completed += 1;
    save();
  }

  // How many days in a row there was some reading or practice (today may still be empty)
  function streakOf(days) {
    const date = new Date();
    const active = function (d) {
      const e = days[dayKey(d)];
      return !!e && (e.s > 0 || e.w > 0 || e.p > 0);
    };
    if (!active(date)) date.setDate(date.getDate() - 1);
    let count = 0;
    while (active(date)) {
      count++;
      date.setDate(date.getDate() - 1);
    }
    return count;
  }

  function lastSevenOf(days) {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const entry = days[dayKey(d)] || { s: 0, w: 0 };
      out.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }), seconds: entry.s || 0, words: entry.w || 0 });
    }
    return out;
  }

  function formatDuration(seconds) {
    const minutes = Math.round(seconds / 60);
    if (seconds < 60) return Math.round(seconds) + "s";
    if (minutes < 60) return minutes + "m";
    return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }

  return {
    reload, addSeconds, addWords, addPractice, addCompletion, streakOf, lastSevenOf, formatDuration,
    streak: function () { return streakOf(data.days); },
    lastSeven: function () { return lastSevenOf(data.days); },
    totals: function () { return data; }
  };
})();

// Results of "Read to Lexi" checks
const Reads = (() => {
  const KEY = "lexi.reads.v1";
  let list = Store.read(KEY, []);
  function reload() { list = Store.read(KEY, []); if (!Array.isArray(list)) list = []; }
  function add(record) {
    list.push(record);
    if (list.length > 60) list = list.slice(-60);
    Store.write(KEY, list);
  }
  function all() { return list; }
  function best() { return list.reduce(function (m, r) { return Math.max(m, r.wpm || 0); }, 0); }
  return { reload, add, all, best };
})();

// ---------------------------------------------------------------------
// 9. TRICKY WORDS (a warm-up list for each passage)
// ---------------------------------------------------------------------
const TrickyWords = (() => {
  const card = $("#trickyCard");
  const chips = $("#trickyChips");
  const markBtn = $("#trickyMarkBtn");
  let current = [];
  let tricky = new Set();

  // Guess which words will be hard for THIS reader
  function analyse(text, lang) {
    const found = new Map();
    (text.match(/[\p{L}'’-]+/gu) || []).forEach(function (raw) {
      const word = normaliseWord(raw);
      if (word.length < 5 || found.has(word) || Lang.isCommon(word, lang)) return;
      const parts = Lang.syllabify(word, lang);
      let score = 0;
      if (word.length >= 7) score += 1;
      if (word.length >= 10) score += 1;
      if (parts.length >= 3) score += 1;
      if (parts.length >= 4) score += 1;
      if ((word.match(/[bdpq]/g) || []).length >= 2) score += 0.5;
      if (/kn|wr|gh|ph|tion|ough|eau|oeu|ç|gn/.test(word)) score += 0.5;
      const known = WordBank.get(word);
      if (known) {
        if (known.bad > 0) score += 2;
        if (known.count >= 2) score += 1;
        if (known.box >= 4) score -= 2;
      }
      if (score >= 1.5) found.set(word, { word: word, score: score, parts: parts });
    });
    return Array.from(found.values())
      .sort(function (a, b) { return b.score - a.score || b.word.length - a.word.length; })
      .slice(0, 8);
  }

  function refresh() {
    if (!originalText) {
      card.classList.add("hidden");
      return;
    }
    current = analyse(originalText, passageLang);
    tricky = new Set(current.map(function (w) { return w.word; }));
    chips.innerHTML = "";
    current.forEach(function (item) {
      const chip = el("button", "chip");
      chip.type = "button";
      chip.appendChild(document.createTextNode(item.word));
      if (item.parts.length > 1) chip.appendChild(el("small", "", item.parts.join("·")));
      chip.addEventListener("click", function () { WordHelper.open(item.word, false, passageLang); });
      chips.appendChild(chip);
    });
    card.classList.toggle("hidden", current.length === 0);
    decorate();
  }

  // Underline the tricky words in the text (if "Mark in text" is on)
  function decorate() {
    const on = !!SettingsModule.get("markTricky");
    readingText.classList.toggle("mark-tricky", on);
    markBtn.setAttribute("aria-pressed", on ? "true" : "false");
    markBtn.textContent = on ? "Hide marks" : "Mark in text";
    wordSpans.forEach(function (span) {
      span.classList.toggle("tricky", tricky.has(normaliseWord(span.textContent)));
    });
  }

  function init() {
    markBtn.addEventListener("click", function () {
      SettingsModule.set("markTricky", !SettingsModule.get("markTricky"));
    });
    $("#trickyPractiseBtn").addEventListener("click", function () {
      let added = 0;
      current.forEach(function (item) { if (WordBank.add(item.word, passageLang)) added++; });
      Toast.show(added > 0 ? added + " word" + (added === 1 ? "" : "s") + " added to Practice" : "Those words are already in Practice", "success");
    });
  }

  return { init, refresh, decorate, analyse };
})();

// ---------------------------------------------------------------------
// 10. READ TO LEXI (listens while you read out loud and marks every word)
// ---------------------------------------------------------------------

// Are two words "the same" for a reading check? (allows small recognition slips)
function sameWord(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && editDistance(a, b) <= 1) return true;
  return false;
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let previous = [];
  for (let j = 0; j <= n; j++) previous.push(j);
  for (let i = 1; i <= m; i++) {
    const row = [i];
    for (let j = 1; j <= n; j++) {
      row.push(Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      ));
    }
    previous = row;
  }
  return previous[n];
}

// Lines up what was spoken with the passage. Returns, for every passage word,
// "ok" (read), "miss" (skipped or wrong) or "skip" (not reached yet), and how far the reader got.
function alignReading(ref, hyp, band) {
  const B = band || 40;
  const n = ref.length;
  const m = hyp.length;
  const W = 2 * B + 1;
  const INF = 1e9;
  const cost = [];
  const back = [];
  for (let j = 0; j <= m; j++) {
    cost.push(new Float32Array(W).fill(INF));
    back.push(new Uint8Array(W));
  }
  // back codes: 1 = matched, 3 = wrong word, 2 = passage word skipped, 4 = extra spoken word
  cost[0][B] = 0;
  for (let i = 1; i <= Math.min(n, B); i++) {
    cost[0][i + B] = i;
    back[0][i + B] = 2;
  }
  for (let j = 1; j <= m; j++) {
    for (let k = 0; k < W; k++) {
      const i = j + k - B;
      if (i < 0 || i > n) continue;
      let best = INF;
      let code = 0;
      if (i >= 1) {
        const c = cost[j - 1][k];
        if (c < INF) {
          const same = sameWord(ref[i - 1], hyp[j - 1]);
          if (c + (same ? 0 : 1) < best) { best = c + (same ? 0 : 1); code = same ? 1 : 3; }
        }
      }
      if (k + 1 < W && cost[j - 1][k + 1] + 1 < best) { best = cost[j - 1][k + 1] + 1; code = 4; }
      if (i >= 1 && k >= 1 && cost[j][k - 1] + 1 < best) { best = cost[j][k - 1] + 1; code = 2; }
      cost[j][k] = best;
      back[j][k] = code;
    }
  }
  // Best place for the reader to have stopped
  let bestI = 0;
  let bestCost = INF;
  for (let k = 0; k < W; k++) {
    const i = m + k - B;
    if (i < 0 || i > n) continue;
    if (cost[m][k] < bestCost) { bestCost = cost[m][k]; bestI = i; }
  }
  const status = new Array(n).fill("skip");
  let i = bestI;
  let j = m;
  while (i > 0 || j > 0) {
    const code = back[j][i - j + B];
    if (code === 1) { status[i - 1] = "ok"; i--; j--; }
    else if (code === 3) { status[i - 1] = "miss"; i--; j--; }
    else if (code === 2) { status[i - 1] = "miss"; i--; }
    else if (code === 4) { j--; }
    else break;
  }
  return { status: status, reached: bestI };
}

const ReadAlong = (() => {
  const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
  const panel = $("#alongPanel");
  const startBtn = $("#alongStart");
  const statusBox = $("#alongStatus");
  const resultBox = $("#alongResult");
  const openBtn = $("#alongBtn");
  let active = false;
  let finalized = true;
  let recognition = null;
  let committed = "";
  let session = "";
  let startedAt = 0;
  let refWords = [];
  let refIndex = [];
  let errorMessage = "";
  let missedWords = [];
  let fallbackTimer = null;

  function tokens(text) {
    return (text.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}']+/gu) || [])
      .map(function (w) { return w.replace(/^'+|'+$/g, ""); })
      .filter(Boolean);
  }

  function clearMarks() {
    wordSpans.forEach(function (span) { span.classList.remove("ok", "miss", "next"); });
  }

  function buildReference() {
    refWords = [];
    refIndex = [];
    wordSpans.forEach(function (span, index) {
      const word = normaliseWord(span.textContent);
      if (word) { refWords.push(word); refIndex.push(index); }
    });
  }

  function applyMarks(result) {
    clearMarks();
    result.status.forEach(function (state, r) {
      const span = wordSpans[refIndex[r]];
      if (!span) return;
      if (state === "ok") span.classList.add("ok");
      else if (state === "miss") span.classList.add("miss");
    });
    const next = wordSpans[refIndex[result.reached]];
    if (next) {
      next.classList.add("next");
      keepInView(next);
    }
  }

  function currentAlignment() {
    return alignReading(refWords, tokens(committed + " " + session));
  }

  function update() {
    const result = currentAlignment();
    applyMarks(result);
    statusBox.innerHTML = '<span class="rec-dot"></span>Listening. ' + result.reached + " words read so far.";
  }

  function open() {
    if (!currentPassage) return;
    if (!SpeechRecognitionClass) {
      Toast.show("Reading checks need Chrome or Edge, with a microphone.", "error");
      return;
    }
    panel.classList.remove("hidden");
    openBtn.setAttribute("aria-pressed", "true");
    prepare();
  }

  function prepare() {
    clearMarks();
    resultBox.classList.add("hidden");
    statusBox.textContent = "";
    startBtn.textContent = "Start reading";
  }

  function begin() {
    resetAudio();
    WordHelper.close();
    renderWordSpans(displayedText || originalText); // fresh text, no leftover marks
    buildReference();
    if (refWords.length < 3) { statusBox.textContent = "This passage is too short for a reading check."; return; }

    committed = "";
    session = "";
    startedAt = 0;
    errorMessage = "";
    finalized = false;
    active = true;
    resultBox.classList.add("hidden");

    recognition = new SpeechRecognitionClass();
    recognition.lang = langTag(displayedLang);
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = function (e) {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript + " ";
      session = text;
      if (!startedAt) startedAt = Date.now();
      update();
    };
    recognition.onerror = function (e) {
      if (e.error === "no-speech" || e.error === "aborted") return;
      active = false;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        errorMessage = "Lexi can't use your microphone. Allow it in your browser, then try again.";
      } else if (e.error === "network") {
        errorMessage = "Listening needs an internet connection. Try again when you are online.";
      } else {
        errorMessage = "Listening stopped (" + e.error + "). Please try again.";
      }
    };
    recognition.onend = function () {
      committed += " " + session;
      session = "";
      if (active) {
        try { recognition.start(); } catch (err) { active = false; finalize(); }
      } else {
        finalize();
      }
    };

    try {
      recognition.start();
    } catch (err) {
      active = false;
      finalized = true;
      statusBox.textContent = "Could not start listening. Please try again.";
      return;
    }
    startBtn.textContent = "Stop and see results";
    statusBox.innerHTML = '<span class="rec-dot"></span>Listening. Read the passage out loud.';
  }

  // silent = just cancel (no results)
  function stop(silent) {
    if (!active && finalized) return;
    active = false;
    if (silent) finalized = true;
    clearTimeout(fallbackTimer);
    if (recognition) { try { recognition.stop(); } catch (e) { /* ignore */ } }
    if (silent) {
      statusBox.textContent = "";
      startBtn.textContent = "Start reading";
    } else {
      fallbackTimer = setTimeout(finalize, 1500); // in case the browser never says "ended"
    }
  }

  function finalize() {
    if (finalized) return;
    finalized = true;
    clearTimeout(fallbackTimer);
    startBtn.textContent = "Start reading";

    const result = currentAlignment();
    applyMarks(result);
    const upTo = result.status.slice(0, result.reached);
    const correct = upTo.filter(function (s) { return s === "ok"; }).length;
    const attempted = upTo.length;

    if (attempted < 3) {
      statusBox.textContent = errorMessage || "Lexi could not hear enough words. Check your microphone and try again.";
      return;
    }
    if (errorMessage) Toast.show(errorMessage, "error");

    const minutes = Math.max((Date.now() - (startedAt || Date.now())) / 60000, 0.05);
    const wpm = Math.round(correct / minutes);
    const accuracy = Math.round((correct / attempted) * 100);

    missedWords = [];
    upTo.forEach(function (state, r) {
      const word = refWords[r];
      if (state === "miss" && word.length >= 2 && !missedWords.includes(word)) missedWords.push(word);
    });
    missedWords = missedWords.slice(0, 12);

    Reads.add({ t: Date.now(), wpm: wpm, acc: accuracy, words: attempted });

    $("#alongWpm").textContent = wpm;
    $("#alongAcc").textContent = accuracy + "%";
    $("#alongCount").textContent = attempted;
    $("#alongTotal").textContent = refWords.length;
    const chips = $("#alongMissed");
    chips.innerHTML = "";
    missedWords.forEach(function (word) {
      const chip = el("button", "chip", word);
      chip.type = "button";
      chip.addEventListener("click", function () { WordHelper.open(word, false, displayedLang); });
      chips.appendChild(chip);
    });
    $("#alongMissedLabel").textContent = missedWords.length > 0 ? "Words to practise:" : "Great job. No missed words.";
    $("#alongPractise").classList.toggle("hidden", missedWords.length === 0);
    resultBox.classList.remove("hidden");
    statusBox.textContent = "Done. Lexi can make mistakes when it listens, so treat this as a guide.";
  }

  function close() {
    stop(true);
    panel.classList.add("hidden");
    openBtn.setAttribute("aria-pressed", "false");
    clearMarks();
  }

  function init() {
    openBtn.addEventListener("click", function () {
      if (panel.classList.contains("hidden")) open(); else close();
    });
    $("#alongClose").addEventListener("click", close);
    startBtn.addEventListener("click", function () {
      if (active) stop(false); else begin();
    });
    $("#alongPractise").addEventListener("click", function () {
      let added = 0;
      missedWords.forEach(function (word) { if (WordBank.noteMissed(word, displayedLang)) added++; });
      Toast.show(missedWords.length + " word" + (missedWords.length === 1 ? "" : "s") + " added to Practice", "success");
    });
  }

  return { init, open, close, stop };
})();

// ---------------------------------------------------------------------
// 11. WORD COACH (practice games with a review schedule)
// ---------------------------------------------------------------------
function makeDistractors(word) {
  const w = word.toLowerCase();
  const swaps = { b: "d", d: "b", p: "q", q: "p", m: "w", w: "m", n: "u", u: "n" };
  const groups = [[], [], [], []];

  for (let i = 0; i < w.length - 1; i++) {
    if (w[i] !== w[i + 1]) groups[0].push(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); // letters swapped
  }
  for (let i = 0; i < w.length; i++) {
    if (swaps[w[i]]) groups[1].push(w.slice(0, i) + swaps[w[i]] + w.slice(i + 1));          // b/d, p/q ...
  }
  for (let i = 0; i < w.length; i++) {
    if ("aeiou".includes(w[i])) {
      "aeiou".split("").forEach(function (v) {
        if (v !== w[i]) groups[2].push(w.slice(0, i) + v + w.slice(i + 1));                 // other vowel
      });
    }
  }
  for (let i = 0; i < w.length; i++) {
    if (w.length > 3) groups[3].push(w.slice(0, i) + w.slice(i + 1));                       // a letter missing
    groups[3].push(w.slice(0, i + 1) + w[i] + w.slice(i + 1));                              // a letter doubled
  }

  const pools = groups.map(function (g) {
    return shuffle(g.filter(function (x) { return x !== w && x.length >= 2; }));
  });
  const chosen = [];
  let round = 0;
  while (chosen.length < 3 && round < 12) {
    pools.forEach(function (pool) {
      if (chosen.length >= 3) return;
      const next = pool.find(function (x) { return !chosen.includes(x); });
      if (next) chosen.push(next);
    });
    round++;
  }
  ["e", "s", "h"].forEach(function (extra) {
    if (chosen.length < 3 && !chosen.includes(w + extra)) chosen.push(w + extra);
  });
  return chosen.slice(0, 3);
}

const Coach = (() => {
  const SESSION_SIZE = 10;
  let queue = [];
  let index = 0;
  let correctCount = 0;
  let answered = false;
  let current = null;

  function refresh() {
    const c = WordBank.counts();
    $("#coachDue").textContent = c.due;
    $("#coachLearning").textContent = c.learning;
    $("#coachMastered").textContent = c.mastered;
    const startBtn = $("#coachStart");
    const message = $("#coachMsg");
    if (c.total === 0) {
      message.textContent = "Your practice list is empty. Tap tricky words while reading, add words from a reading check, or type a word below.";
      startBtn.disabled = true;
      startBtn.textContent = "Start practice";
    } else if (c.due === 0) {
      message.textContent = "You are all caught up. Words come back when it is time to review them. You can still practise now.";
      startBtn.disabled = false;
      startBtn.textContent = "Practise anyway";
    } else {
      message.textContent = c.due + " word" + (c.due === 1 ? " is" : "s are") + " ready. A session takes about 3 minutes.";
      startBtn.disabled = false;
      startBtn.textContent = "Start practice";
    }
  }

  function start() {
    let list = WordBank.due();
    if (list.length === 0) {
      list = WordBank.all().sort(function (a, b) { return a.box - b.box || a.last - b.last; });
    }
    queue = shuffle(list.slice(0, SESSION_SIZE));
    if (queue.length === 0) return;
    index = 0;
    correctCount = 0;
    $("#coachHome").classList.add("hidden");
    $("#coachSession").classList.remove("hidden");
    showQuestion();
  }

  function end() {
    $("#coachSession").classList.add("hidden");
    $("#coachHome").classList.remove("hidden");
    synth.cancel();
    refresh();
  }

  function exerciseFor(entry) {
    const parts = Lang.syllabify(entry.word, entry.lang || "en");
    if (entry.box <= 2) return "pick";
    if (entry.box === 3) return parts.length > 1 ? "build" : "pick";
    return entry.word.length >= 3 ? "type" : "pick";
  }

  function hearButton(entry, withSyllables) {
    const wrap = el("div", "");
    const hear = el("button", "btn btn-primary coach-hear");
    hear.type = "button";
    hear.setAttribute("aria-label", "Hear the word");
    hear.innerHTML = icon("volume");
    hear.addEventListener("click", function () { WordHelper.hear(entry.word, entry.lang || "en"); });
    wrap.appendChild(hear);
    if (withSyllables) {
      const slow = el("button", "btn btn-ghost btn-sm", "Hear by syllable");
      slow.type = "button";
      slow.style.display = "block";
      slow.style.margin = "-8px auto 12px";
      slow.addEventListener("click", function () { WordHelper.hearBySyllable(entry.word, entry.lang || "en"); });
      wrap.appendChild(slow);
    }
    return wrap;
  }

  function showQuestion() {
    answered = false;
    current = queue[index];
    $("#coachCount").textContent = "Word " + (index + 1) + " of " + queue.length;
    $("#coachProgress").style.width = Math.round((index / queue.length) * 100) + "%";
    const stage = $("#coachStage");
    stage.innerHTML = "";
    const kind = exerciseFor(current);
    if (kind === "pick") renderPick(stage);
    else if (kind === "build") renderBuild(stage);
    else renderType(stage);
    setTimeout(function () { if (!answered) WordHelper.hear(current.word, current.lang || "en"); }, 250);
  }

  function renderPick(stage) {
    stage.appendChild(el("p", "coach-prompt", "Listen, then choose the correct spelling."));
    stage.appendChild(hearButton(current, false));
    const options = el("div", "options");
    shuffle([current.word].concat(makeDistractors(current.word))).forEach(function (text) {
      const button = el("button", "opt", text);
      button.type = "button";
      button.addEventListener("click", function () {
        if (answered) return;
        const right = text === current.word;
        button.classList.add(right ? "correct" : "wrong");
        $$(".opt", options).forEach(function (o) {
          o.disabled = true;
          if (o.textContent === current.word) o.classList.add("correct");
        });
        finish(right);
      });
      options.appendChild(button);
    });
    stage.appendChild(options);
  }

  function renderBuild(stage) {
    const parts = Lang.syllabify(current.word, current.lang || "en");
    stage.appendChild(el("p", "coach-prompt", "Put the syllables in the right order."));
    stage.appendChild(hearButton(current, true));
    const slots = el("div", "slots");
    slots.setAttribute("aria-label", "Your answer");
    const pool = el("div", "chips");
    pool.style.justifyContent = "center";
    const chosen = [];

    function redraw() {
      slots.innerHTML = "";
      pool.innerHTML = "";
      chosen.forEach(function (piece, i) {
        const chip = el("button", "chip", piece.text);
        chip.type = "button";
        chip.addEventListener("click", function () { if (!answered) { chosen.splice(i, 1); redraw(); } });
        slots.appendChild(chip);
      });
      pieces.forEach(function (piece) {
        if (chosen.includes(piece)) return;
        const chip = el("button", "chip", piece.text);
        chip.type = "button";
        chip.addEventListener("click", function () {
          if (answered) return;
          chosen.push(piece);
          redraw();
          if (chosen.length === pieces.length) {
            const right = chosen.map(function (p) { return p.text; }).join("") === current.word;
            slots.style.borderColor = right ? "var(--success)" : "var(--danger)";
            finish(right);
          }
        });
        pool.appendChild(chip);
      });
    }
    const pieces = shuffle(parts.map(function (text) { return { text: text }; }));
    stage.appendChild(slots);
    stage.appendChild(pool);
    redraw();
  }

  function renderType(stage) {
    stage.appendChild(el("p", "coach-prompt", "Listen, then type the word."));
    stage.appendChild(hearButton(current, true));
    const row = el("div", "type-row");
    const input = el("input");
    input.type = "text";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("aria-label", "Type the word");
    const check = el("button", "btn btn-primary", "Check");
    check.type = "button";
    function submit() {
      if (answered || !input.value.trim()) return;
      const right = input.value.trim().toLowerCase().normalize("NFC") === current.word.toLowerCase().normalize("NFC");
      input.disabled = true;
      check.disabled = true;
      finish(right);
    }
    check.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    row.appendChild(input);
    row.appendChild(check);
    stage.appendChild(row);
    setTimeout(function () { input.focus(); }, 300);
  }

  function finish(right) {
    answered = true;
    WordBank.grade(current.word, right);
    StatsModule.addPractice(1);
    if (right) correctCount++;
    const stage = $("#coachStage");
    const parts = Lang.syllabify(current.word, current.lang || "en");
    const box = el("div", "feedback " + (right ? "good" : "bad"));
    box.appendChild(document.createTextNode(right ? "Correct. Well done." : "Not quite. The word is:"));
    box.appendChild(el("span", "big", parts.join(" · ")));
    stage.appendChild(box);
    const last = index === queue.length - 1;
    const next = el("button", "btn btn-primary coach-next", last ? "See results" : "Next word");
    next.type = "button";
    next.addEventListener("click", function () {
      synth.cancel();
      if (last) summary(); else { index++; showQuestion(); }
    });
    stage.appendChild(next);
    setTimeout(function () { next.focus(); }, 50);
  }

  function summary() {
    $("#coachProgress").style.width = "100%";
    $("#coachCount").textContent = "Finished";
    const stage = $("#coachStage");
    stage.innerHTML = "";
    const wrap = el("div", "coach-summary");
    wrap.appendChild(el("h2", "", "Session complete"));
    wrap.appendChild(el("div", "big-num", correctCount + " / " + queue.length));
    wrap.appendChild(el("p", "muted", correctCount === queue.length
      ? "Perfect. Those words will come back later to keep them fresh."
      : "Words you missed will come back soon. Practice makes them stick."));
    const actions = el("div", "empty-actions");
    actions.style.marginTop = "16px";
    const again = el("button", "btn btn-primary", "Practise again");
    again.type = "button";
    again.addEventListener("click", start);
    const done = el("button", "btn btn-secondary", "Done");
    done.type = "button";
    done.addEventListener("click", end);
    actions.appendChild(again);
    actions.appendChild(done);
    wrap.appendChild(actions);
    stage.appendChild(wrap);
  }

  function init() {
    $("#coachStart").addEventListener("click", start);
    $("#coachQuit").addEventListener("click", end);
    $("#addWordForm").addEventListener("submit", function (e) {
      e.preventDefault();
      const input = $("#addWordInput");
      const word = normaliseWord(input.value.trim());
      if (!word || /\s/.test(word)) { Toast.show("Type one word.", "error"); return; }
      const lang = Lang.detect(word + " " + word) === "fr" ? "fr" : (/[éèêëàâçîïôùûœ]/.test(word) ? "fr" : "en");
      const added = WordBank.add(word, lang);
      input.value = "";
      Toast.show(added ? "“" + word + "” added" : "That word is already in your list", added ? "success" : "info");
      refresh();
    });
  }

  return { init, refresh };
})();

// ---------------------------------------------------------------------
// 12. FIND MY BEST SETTINGS (a short reading test)
// ---------------------------------------------------------------------
const Calibration = (() => {
  const KEY = "lexi.calib.v1";

  const PRESETS = [
    { id: "compact", name: "Compact", fontSize: 20, lineHeight: 1.5, letterSpacing: 0, wordSpacing: 2 },
    { id: "comfortable", name: "Comfortable", fontSize: 22, lineHeight: 1.8, letterSpacing: 1.5, wordSpacing: 6 },
    { id: "roomy", name: "Roomy", fontSize: 24, lineHeight: 2.0, letterSpacing: 3, wordSpacing: 10 },
    { id: "extra", name: "Extra roomy", fontSize: 26, lineHeight: 2.2, letterSpacing: 5, wordSpacing: 14 }
  ];

  const PASSAGES = [
    {
      text: "A small boat left the harbour at sunrise. The fishermen threw their nets into the cold water and waited. By noon, the nets were heavy with silver fish, and the boat turned slowly back towards the shore.",
      question: "What did the nets hold by noon?",
      right: "Silver fish", wrong: ["Old shoes", "Bright flowers"]
    },
    {
      text: "Every Saturday, Mia walks to the market with her grandmother. They buy ripe mangoes, fresh bread and a bunch of yellow flowers. Mia carries the basket carefully, because the eggs inside are easy to break.",
      question: "Why does Mia carry the basket carefully?",
      right: "The eggs are easy to break", wrong: ["It is very heavy", "She is wearing new shoes"]
    },
    {
      text: "The old clock in the village square had stopped for many years. One morning, a young girl climbed the tower with a small toolbox. After an hour of careful work, the clock began to tick again, and the villagers cheered loudly.",
      question: "What did the girl do?",
      right: "She fixed the clock", wrong: ["She painted the tower", "She sold the clock"]
    },
    {
      text: "When the rain finally came, the dry fields turned green within days. Farmers planted maize and beans, and children played in the puddles after school. The whole village felt hopeful about the new season.",
      question: "What happened to the fields after the rain?",
      right: "They turned green", wrong: ["They filled with sand", "They were sold"]
    }
  ];

  // How well did each layout work? Fast + understood + comfortable = a high score.
  function score(result) {
    const seconds = Math.max(result.seconds, result.words / 6); // nobody reads faster than 360 words per minute
    const wpm = result.words / (seconds / 60);
    const understood = result.correct ? 1 : 0.6;
    const comfort = 0.7 + 0.075 * result.comfort;
    return { wpm: Math.round(wpm), score: wpm * understood * comfort };
  }

  function pickBest(results) {
    let best = null;
    results.forEach(function (r) {
      const s = score(r);
      const item = Object.assign({}, r, { wpm: s.wpm, score: s.score });
      if (!best || item.score > best.score) best = item;
    });
    return best;
  }

  const body = $("#calibBody");
  const dialog = $("#calibDialog");
  let steps = [];
  let stepIndex = 0;

  function presetStyle(preset) {
    return "--read-size:" + preset.fontSize + "px;--read-lh:" + preset.lineHeight +
      ";--read-ls:" + preset.letterSpacing + "px;--read-ws:" + preset.wordSpacing + "px;";
  }

  function intro() {
    body.innerHTML = "";
    const wrap = el("div", "calib-intro");
    wrap.appendChild(el("p", "", "You will read 4 short texts. Each one looks a little different, with different text size and spacing."));
    const list = el("ul");
    ["Read silently, at your normal speed.", "Press Done as soon as you finish.", "Then answer one easy question and say how comfortable it felt."]
      .forEach(function (t) { list.appendChild(el("li", "", t)); });
    wrap.appendChild(list);
    wrap.appendChild(el("p", "muted small", "This is a guide to help you choose settings, not a medical test. It takes about 3 minutes."));
    const actions = el("div", "calib-actions");
    const go = el("button", "btn btn-primary", "Begin");
    go.type = "button";
    go.addEventListener("click", begin);
    actions.appendChild(go);
    wrap.appendChild(actions);
    body.appendChild(wrap);
  }

  function begin() {
    const presets = shuffle(PRESETS);
    const passages = shuffle(PASSAGES);
    steps = presets.map(function (preset, i) {
      return { preset: preset, passage: passages[i], seconds: 0, correct: false, comfort: 3, words: countWords(passages[i].text) };
    });
    stepIndex = 0;
    showText();
  }

  function showText() {
    const step = steps[stepIndex];
    body.innerHTML = "";
    body.appendChild(el("p", "calib-step", "Text " + (stepIndex + 1) + " of " + steps.length));
    const box = el("div", "calib-text");
    box.setAttribute("style", presetStyle(step.preset));
    const text = el("p", "reading-text", "Press Start when you are ready.");
    box.appendChild(text);
    body.appendChild(box);
    const actions = el("div", "calib-actions");
    const button = el("button", "btn btn-primary", "Start");
    button.type = "button";
    let t0 = 0;
    button.addEventListener("click", function () {
      if (!t0) {
        t0 = Date.now();
        text.textContent = step.passage.text;
        button.textContent = "Done reading";
      } else {
        step.seconds = (Date.now() - t0) / 1000;
        showQuestion();
      }
    });
    actions.appendChild(button);
    body.appendChild(actions);
    button.focus();
  }

  function showQuestion() {
    const step = steps[stepIndex];
    body.innerHTML = "";
    body.appendChild(el("p", "calib-step", "Text " + (stepIndex + 1) + " of " + steps.length));
    body.appendChild(el("p", "calib-q", step.passage.question));
    let answer = null;
    let comfort = null;
    const next = el("button", "btn btn-primary", stepIndex === steps.length - 1 ? "See my results" : "Next text");
    next.type = "button";
    next.disabled = true;

    const opts = el("div", "calib-opts");
    shuffle([step.passage.right].concat(step.passage.wrong)).forEach(function (text) {
      const button = el("button", "opt", text);
      button.type = "button";
      button.addEventListener("click", function () {
        answer = text;
        $$(".opt", opts).forEach(function (o) { o.classList.toggle("picked", o === button); });
        ready();
      });
      opts.appendChild(button);
    });
    body.appendChild(opts);

    body.appendChild(el("p", "calib-q", "How easy was that text to read?"));
    const scale = el("div", "scale");
    [1, 2, 3, 4, 5].forEach(function (n) {
      const button = el("button", "opt", String(n));
      button.type = "button";
      button.addEventListener("click", function () {
        comfort = n;
        $$(".opt", scale).forEach(function (o) { o.classList.toggle("picked", o === button); });
        ready();
      });
      scale.appendChild(button);
    });
    body.appendChild(scale);
    const labels = el("div", "scale-labels");
    labels.appendChild(el("span", "", "1 = hard"));
    labels.appendChild(el("span", "", "5 = easy"));
    body.appendChild(labels);

    function ready() { next.disabled = !(answer !== null && comfort !== null); }
    next.addEventListener("click", function () {
      step.correct = answer === step.passage.right;
      step.comfort = comfort;
      stepIndex++;
      if (stepIndex < steps.length) showText(); else results();
    });
    const actions = el("div", "calib-actions");
    actions.appendChild(next);
    body.appendChild(actions);
  }

  function results() {
    const scored = steps.map(function (s) {
      const sc = score(s);
      return { id: s.preset.id, name: s.preset.name, preset: s.preset, wpm: sc.wpm, score: sc.score, correct: s.correct, comfort: s.comfort };
    });
    const best = scored.reduce(function (a, b) { return b.score > a.score ? b : a; });
    const top = Math.max.apply(null, scored.map(function (s) { return s.score; }));

    body.innerHTML = "";
    body.appendChild(el("p", "calib-step", "Your results"));
    scored.slice().sort(function (a, b) { return PRESETS.findIndex(function (p) { return p.id === a.id; }) - PRESETS.findIndex(function (p) { return p.id === b.id; }); })
      .forEach(function (s) {
        const row = el("div", "result-row" + (s.id === best.id ? " best" : ""));
        row.appendChild(el("span", "", s.name));
        const bar = el("div", "rbar");
        const fill = el("span");
        fill.style.width = Math.max(6, Math.round((s.score / top) * 100)) + "%";
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el("span", "muted small", s.wpm + " wpm"));
        body.appendChild(row);
      });

    const p = best.preset;
    const box = el("div", "best-box");
    box.appendChild(el("strong", "", "Best for you: " + best.name));
    box.appendChild(el("span", "muted small",
      "Text size " + p.fontSize + "px, line spacing " + p.lineHeight + ", letter spacing " + p.letterSpacing +
      "px, word spacing " + p.wordSpacing + "px."));
    body.appendChild(box);
    body.appendChild(el("p", "muted small", "A short test can be affected by tiredness and by the texts themselves. If it does not feel right, adjust the sliders in Settings or run the test again."));

    const actions = el("div", "calib-actions");
    const keep = el("button", "btn btn-ghost", "Keep my current settings");
    keep.type = "button";
    keep.addEventListener("click", function () { saveResult(scored, best, false); dialog.close(); });
    const apply = el("button", "btn btn-primary", "Use these settings");
    apply.type = "button";
    apply.addEventListener("click", function () {
      SettingsModule.setMany({ fontSize: p.fontSize, lineHeight: p.lineHeight, letterSpacing: p.letterSpacing, wordSpacing: p.wordSpacing });
      saveResult(scored, best, true);
      dialog.close();
      Toast.show("Settings updated: " + best.name, "success");
    });
    actions.appendChild(keep);
    actions.appendChild(apply);
    body.appendChild(actions);
  }

  function saveResult(scored, best, applied) {
    Store.write(KEY, {
      t: Date.now(),
      best: best.id,
      bestName: best.name,
      applied: applied,
      values: { fontSize: best.preset.fontSize, lineHeight: best.preset.lineHeight, letterSpacing: best.preset.letterSpacing, wordSpacing: best.preset.wordSpacing },
      results: scored.map(function (s) { return { id: s.id, wpm: s.wpm, correct: s.correct, comfort: s.comfort }; })
    });
    updateLast();
  }

  function updateLast() {
    const saved = Store.read(KEY, null);
    $("#calibLast").textContent = saved && saved.bestName
      ? "Last result: " + saved.bestName + " layout, on " + new Date(saved.t).toLocaleDateString() + (saved.applied ? " (applied)." : ".")
      : "";
  }

  function init() {
    $("#calibStartBtn").addEventListener("click", function () {
      intro();
      dialog.showModal();
    });
    $("#calibClose").addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
    updateLast();
  }

  return { init, updateLast, score, pickBest, PRESETS };
})();

// ---------------------------------------------------------------------
// 13. INSIGHTS, LIBRARY, ADD-PASSAGE TOOLS
// ---------------------------------------------------------------------

// Draw a simple bar chart into a container. items: [{ label, value, text, title }]
function drawBars(container, items) {
  container.innerHTML = "";
  const max = Math.max.apply(null, items.map(function (d) { return d.value; }).concat([1]));
  items.forEach(function (item) {
    const col = el("div", "bar-col");
    col.appendChild(el("span", "bar-value", item.value > 0 ? item.text : ""));
    const bar = el("div", "bar" + (item.value > 0 ? "" : " zero"));
    bar.style.height = item.value > 0 ? Math.max(6, Math.round((item.value / max) * 110)) + "px" : "4px";
    if (item.title) bar.title = item.title;
    col.appendChild(bar);
    col.appendChild(el("span", "bar-label", item.label));
    container.appendChild(col);
  });
}

function weekItems(week) {
  return week.map(function (day) {
    return {
      label: day.label,
      value: day.seconds,
      text: day.seconds < 60 ? "<1m" : Math.round(day.seconds / 60) + "m",
      title: day.label + ": " + StatsModule.formatDuration(day.seconds) + ", " + day.words + " words"
    };
  });
}

function readItems(reads) {
  return reads.slice(-10).map(function (r) {
    const label = new Date(r.t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    return { label: label, value: r.wpm, text: String(r.wpm), title: r.wpm + " words per minute, " + r.acc + "% accuracy" };
  });
}

const InsightsView = (() => {
  function renderWords() {
    const ul = $("#wordList");
    ul.innerHTML = "";
    const items = WordBank.list();
    $("#wordEmpty").classList.toggle("hidden", items.length > 0);
    $("#clearWordsBtn").classList.toggle("hidden", items.length === 0);

    items.forEach(function (item) {
      const li = document.createElement("li");
      const lang = item.lang || "en";

      const hear = el("button", "icon-btn");
      hear.type = "button";
      hear.setAttribute("aria-label", "Hear " + item.word);
      hear.innerHTML = icon("volume");
      hear.addEventListener("click", function () { WordHelper.hear(item.word, lang); });

      const info = el("button", "btn btn-ghost btn-sm", "Meaning");
      info.type = "button";
      info.addEventListener("click", function () { WordHelper.open(item.word, false, lang); });

      const del = el("button", "icon-btn");
      del.type = "button";
      del.setAttribute("aria-label", "Remove " + item.word + " from the list");
      del.innerHTML = icon("x");
      del.addEventListener("click", function () {
        WordBank.remove(item.word);
        renderWords();
      });

      li.appendChild(el("span", "wl-word", item.word));
      li.appendChild(el("span", "wl-syll", Lang.syllabify(item.word, lang).join(" · ")));
      li.appendChild(el("span", "wl-count", item.box >= 4 ? "Mastered" : "×" + item.count));
      [hear, info, del].forEach(function (node) { li.appendChild(node); });
      ul.appendChild(li);
    });
  }

  function render() {
    const totals = StatsModule.totals();
    $("#statStreak").textContent = StatsModule.streak();
    $("#statWords").textContent = Math.round(totals.totalWords).toLocaleString();
    $("#statTime").textContent = StatsModule.formatDuration(totals.totalSeconds);
    $("#statDone").textContent = totals.completed;
    $("#statMastered").textContent = WordBank.counts().mastered;
    const best = Reads.best();
    $("#statBest").textContent = best > 0 ? best + " wpm" : "-";

    drawBars($("#weekChart"), weekItems(StatsModule.lastSeven()));
    const reads = Reads.all();
    $("#fluencyEmpty").classList.toggle("hidden", reads.length > 0);
    $("#fluencyChart").classList.toggle("hidden", reads.length === 0);
    drawBars($("#fluencyChart"), readItems(reads));
    renderWords();
  }

  function init() {
    $("#clearWordsBtn").addEventListener("click", function () {
      if (confirm("Clear your whole practice list?")) {
        WordBank.clearAll();
        renderWords();
      }
    });
  }

  return { init, render };
})();

// ---------- the library (your passages, saved on your account) ----------
const SAMPLE_PASSAGE = {
  title: "Welcome to Lexi",
  text: "Welcome to Lexi. Lexi helps you read with less effort. Press play and the words light up as they are spoken. " +
    "Tap any word to hear it, see how it splits into syllables, and read what it means. " +
    "Try the reading ruler in the player bar to keep your place on the line."
};

const Library = (() => {
  const CACHE = "lexi.cache.passages";
  let passages = [];
  let failed = false;
  let fromCache = false;
  const grid = $("#passageList");
  const status = $("#passageStatus");
  const retry = $("#retryBtn");
  const empty = $("#emptyState");
  const search = $("#searchInput");

  function create(text, title) { return Api.post("/api/passages", { title: title, text: text }); }
  function update(id, text, title) { return Api.put("/api/passages/" + id, { title: title, text: text }); }
  function remove(id) { return Api.del("/api/passages/" + id); }

  async function refresh() {
    if (passages.length === 0) status.textContent = "Loading your passages…";
    try {
      const result = await Api.get("/api/passages");
      if (!Array.isArray(result)) throw new Error("Unexpected answer from the server");
      passages = result;
      failed = false;
      fromCache = false;
      Store.rawWrite(CACHE, { uid: Session.user ? Session.user.id : null, list: passages });
    } catch (e) {
      const cached = Store.read(CACHE, null);
      if (e.offline && cached && Array.isArray(cached.list) && Session.user && cached.uid === Session.user.id) {
        passages = cached.list;
        failed = false;
        fromCache = true;
      } else {
        failed = true;
      }
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
    if (term && shown.length === 0) status.textContent = "No passages match “" + search.value.trim() + "”.";
    else status.textContent = fromCache ? "Offline: showing the passages saved on this device." : "";
    empty.classList.toggle("hidden", passages.length > 0);

    shown.forEach(function (p) {
      const card = el("article", "p-card");

      const open = el("button", "p-open");
      open.type = "button";
      open.setAttribute("aria-label", "Open " + p.title);

      const meta = el("p", "p-meta");
      const words = countWords(p.text);
      [words + " words", "~" + Math.max(1, Math.round(words / 150)) + " min", formatDate(p.created_at)]
        .filter(Boolean)
        .forEach(function (piece) { meta.appendChild(el("span", "", piece)); });

      open.appendChild(el("h3", "p-title", p.title));
      open.appendChild(el("p", "p-excerpt", p.text));
      open.appendChild(meta);
      open.addEventListener("click", function () { App.openPassage({ id: p.id, title: p.title, text: p.text }); });

      const del = el("button", "icon-btn p-del");
      del.type = "button";
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
    if (!needOnline("You are offline. Connect to the internet to delete passages.")) return;
    if (!confirm("Delete “" + p.title + "”? This can't be undone.")) return;
    try {
      await remove(p.id);
      if (currentPassage && currentPassage.id === p.id) showReaderEmpty();
      Toast.show("Passage deleted", "success");
      await refresh();
    } catch (e) {
      Toast.show("Could not delete the passage.", "error");
    }
  }

  function reset() {
    passages = [];
    failed = false;
    fromCache = false;
    draw();
  }

  function init() {
    search.addEventListener("input", draw);
    retry.addEventListener("click", refresh);
    $("#newPassageBtn").addEventListener("click", function () {
      if (needOnline("You are offline. Connect to the internet to add passages.")) AddDialog.open({ mode: "new" });
    });
    $("#emptyAddBtn").addEventListener("click", function () {
      if (needOnline("You are offline. Connect to the internet to add passages.")) AddDialog.open({ mode: "new" });
    });
    $("#sampleBtn").addEventListener("click", function () {
      if (needOnline("You are offline. Connect to the internet to add passages.")) {
        App.saveAndOpen(SAMPLE_PASSAGE.text, SAMPLE_PASSAGE.title);
      }
    });
  }

  return { init, refresh, reset, create, update, remove };
})();

// ---------- add a passage: clean text, upload a file, scan a photo, the dialog ----------
const TextCleaner = (() => {
  function clean(raw) {
    if (!raw || typeof raw !== "string") return "";
    let text = raw;
    text = text.normalize("NFKC");
    text = text
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/…/g, "...");
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    text = text.replace(/-\s*\n\s*/g, "");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.split("\n").map(function (line) { return line.trim(); }).join("\n");
    // a lone "l" is usually a scanning mistake for "I" (but not in French "l'ecole")
    text = text.replace(/(?<![\p{L}'])l(?![\p{L}'])/gu, "I").replace(/\s+([.,!?;:])/g, "$1");
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
      processBtn.textContent = "Extracting…";
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
    setProgress(0, "Loading the scanner…");
    const result = await Tesseract.recognize(file, "eng+fra", {
      logger: function (m) {
        if (m.status === "recognizing text") {
          const percent = Math.round((m.progress || 0) * 100);
          setProgress(percent, "Reading the photo… " + percent + "%");
        } else {
          setProgress(0, m.status);
        }
      }
    });
    setProgress(100, "Done!");
    hideProgress();
    return result.data.text;
  }

  function runOnFile(file) { return runOcr(file); }

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

  return { init, open, close, editingId: function () { return editingId; } };
})();

// ---------------------------------------------------------------------
// 14. SHARING (a private progress link for a teacher or parent)
// ---------------------------------------------------------------------
const Share = (() => {
  function link(code) { return location.origin + "/?share=" + code; }

  function show(code) {
    $("#shareOff").classList.toggle("hidden", !!code);
    $("#shareOn").classList.toggle("hidden", !code);
    $("#shareLink").value = code ? link(code) : "";
  }

  async function load() {
    try {
      const result = await Api.get("/api/share");
      show(result.code);
    } catch (e) {
      show(null);
    }
  }

  function init() {
    $("#shareCreateBtn").addEventListener("click", async function () {
      if (!needOnline()) return;
      try {
        const result = await Api.post("/api/share");
        show(result.code);
        Toast.show("Share link created", "success");
      } catch (e) {
        Toast.show("Could not create the link.", "error");
      }
    });
    $("#shareStopBtn").addEventListener("click", async function () {
      if (!needOnline()) return;
      try {
        await Api.del("/api/share");
        show(null);
        Toast.show("Sharing turned off. The old link no longer works.", "success");
      } catch (e) {
        Toast.show("Could not turn sharing off.", "error");
      }
    });
    $("#shareCopyBtn").addEventListener("click", async function () {
      const input = $("#shareLink");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch (e) {
        input.select();
        document.execCommand("copy");
      }
      Toast.show("Link copied", "success");
    });
  }

  return { init, load };
})();

// The report a teacher or parent sees when they open a share link
const ShareView = (() => {
  function tile(label, value) {
    const box = el("div", "stat");
    box.appendChild(el("span", "stat-label", label));
    box.appendChild(el("strong", "", String(value)));
    return box;
  }

  function levelOf(word) {
    if (word.box >= 4) return ["Mastered", "mastered"];
    if (word.box >= 2) return ["Learning", "learning"];
    return ["Needs help", "help"];
  }

  function render(data) {
    const body = $("#shareBody");
    body.innerHTML = "";

    const brand = el("div", "brand");
    brand.style.padding = "0";
    brand.appendChild(el("span", "brand-mark", "L"));
    brand.appendChild(el("span", "brand-name", "Lexi"));
    body.appendChild(brand);
    body.appendChild(el("h1", "", "Reading progress for " + data.name));
    body.appendChild(el("span", "share-tag", "Read-only report"));

    const days = data.stats.days || {};
    const grid = el("div", "stat-grid");
    grid.style.marginTop = "18px";
    grid.appendChild(tile("Day streak", StatsModule.streakOf(days)));
    grid.appendChild(tile("Words read", Math.round(data.stats.totalWords).toLocaleString()));
    grid.appendChild(tile("Time listening", StatsModule.formatDuration(data.stats.totalSeconds)));
    grid.appendChild(tile("Passages finished", data.stats.completed));
    body.appendChild(grid);

    const weekCard = el("div", "card");
    weekCard.appendChild(el("h2", "", "Last 7 days"));
    const week = el("div", "chart");
    weekCard.appendChild(week);
    body.appendChild(weekCard);
    drawBars(week, weekItems(StatsModule.lastSevenOf(days)));

    const readsCard = el("div", "card");
    readsCard.appendChild(el("h2", "", "Reading checks"));
    if (data.reads.length === 0) {
      readsCard.appendChild(el("p", "muted", "No reading checks yet."));
    } else {
      const chart = el("div", "chart");
      readsCard.appendChild(chart);
      drawBars(chart, readItems(data.reads));
      const table = el("table", "report-table");
      const head = el("tr");
      ["Date", "Speed", "Accuracy", "Words"].forEach(function (h) { head.appendChild(el("th", "", h)); });
      table.appendChild(head);
      data.reads.slice(-6).reverse().forEach(function (r) {
        const row = el("tr");
        [new Date(r.t).toLocaleDateString(), r.wpm + " wpm", r.acc + "%", r.words].forEach(function (cell) {
          row.appendChild(el("td", "", String(cell)));
        });
        table.appendChild(row);
      });
      readsCard.appendChild(table);
    }
    body.appendChild(readsCard);

    const wordsCard = el("div", "card");
    wordsCard.appendChild(el("h2", "", "Practice words"));
    if (data.words.length === 0) {
      wordsCard.appendChild(el("p", "muted", "No practice words yet."));
    } else {
      const table = el("table", "report-table");
      const head = el("tr");
      ["Word", "Level", "Looked up", "Right / wrong"].forEach(function (h) { head.appendChild(el("th", "", h)); });
      table.appendChild(head);
      data.words.forEach(function (w) {
        const row = el("tr");
        const level = levelOf(w);
        row.appendChild(el("td", "", w.word));
        const levelCell = el("td");
        levelCell.appendChild(el("span", "level " + level[1], level[0]));
        row.appendChild(levelCell);
        row.appendChild(el("td", "", String(w.count)));
        row.appendChild(el("td", "", w.ok + " / " + w.bad));
        table.appendChild(row);
      });
      wordsCard.appendChild(table);
    }
    body.appendChild(wordsCard);

    if (data.calib && data.calib.bestName) {
      const calibCard = el("div", "card");
      calibCard.appendChild(el("h2", "", "Best text layout"));
      const v = data.calib.values || {};
      calibCard.appendChild(el("p", "muted",
        data.calib.bestName + " layout: text size " + v.fontSize + "px, line spacing " + v.lineHeight +
        ", letter spacing " + v.letterSpacing + "px, word spacing " + v.wordSpacing + "px."));
      body.appendChild(calibCard);
    }

    body.appendChild(el("p", "muted small", "This report shows reading activity only. It does not include any email address or passage text."));
  }

  async function open(code) {
    document.body.dataset.mode = "share";
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("#authScreen").classList.add("hidden");
    $("#appShell").classList.add("hidden");
    const view = $("#shareView");
    view.classList.remove("hidden");
    const body = $("#shareBody");
    body.textContent = "Loading the report…";
    try {
      const response = await fetch(API_URL + "/api/shared/" + encodeURIComponent(code));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "This link is not valid.");
      render(data);
    } catch (e) {
      body.innerHTML = "";
      body.appendChild(el("h1", "", "Report not available"));
      body.appendChild(el("p", "muted", e.message || "This link is not valid."));
      const home = el("a", "btn btn-primary", "Open Lexi");
      home.href = "/";
      home.style.marginTop = "16px";
      body.appendChild(home);
    }
  }

  return { open };
})();

// ---------------------------------------------------------------------
// 15. APP - connects everything together and starts it
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
    if (!needOnline("You are offline. Connect to the internet to save passages.")) return;
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
    if (!needOnline("You are offline. Connect to the internet to edit passages.")) return;
    AddDialog.open({ mode: "edit", id: currentPassage.id, title: currentPassage.title, text: currentPassage.text });
  }

  // The user is signed in: load their data into every part of the app
  function onSignedIn(user, info) {
    SettingsModule.reload();
    StatsModule.reload();
    WordBank.reload();
    Reads.reload();
    Calibration.updateLast();
    Library.reset();

    const initial = (user.name || "?").trim().charAt(0).toUpperCase() || "?";
    $("#accountAvatar").textContent = initial;
    $("#accountName").textContent = user.name;
    $("#acAvatar").textContent = initial;
    $("#acName").textContent = user.name;
    $("#acEmail").textContent = user.email || "";
    $("#acSessionNote").textContent = info.remember
      ? "You stay signed in on this device. Lexi signs you out after 30 days without use."
      : "Lexi signs you out after 2 hours without use, or when you close the browser.";

    Nav.show("library");
    Library.refresh();
    if (!info.offline) Share.load();
    Coach.refresh();
    updateOnlineBar();
  }

  function updateOnlineBar() {
    $("#offlineBar").classList.toggle("hidden", navigator.onLine !== false);
    if (navigator.onLine !== false) Cloud.flush();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost") return;
    navigator.serviceWorker.register("sw.js").catch(function () { /* the app still works without it */ });
  }

  function init() {
    SettingsModule.init();
    RulerModule.init();
    Nav.init();
    initReadAloud();
    WordHelper.init();
    TrickyWords.init();
    ReadAlong.init();
    Coach.init();
    Calibration.init();
    InsightsView.init();
    AddDialog.init();
    Library.init();
    Share.init();
    AuthUI.init();

    TextInputModule.init(handleProcessedText);
    FileUploadModule.init(handleProcessedText);
    OcrModule.init(handleProcessedText);
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    }

    $("#editPassageBtn").addEventListener("click", startEditing);
    $("#signOutBtn").addEventListener("click", function () { Session.signOut(); });
    window.addEventListener("online", updateOnlineBar);
    window.addEventListener("offline", updateOnlineBar);

    registerServiceWorker();
    Session.start();
  }

  return { init, openPassage, saveAndOpen, onSignedIn };
})();

App.init();
