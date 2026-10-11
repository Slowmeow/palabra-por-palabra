import {
  reflowText, buildStructure, contextAround, tokenize, esc, searchKey, isChapterHeading, wordKey,
} from "./text.js";
import {
  MODELS, FACT_TYPES, factKey, modelInfo, generateCard, explainContext, lookupWords, checkKey, estimateCardCost,
} from "./claude.js";
import { I } from "./icons.js";
import { t, th, setUiLang, uiLang, UI_LANGS } from "./i18n.js";
import { STUDY_LANGS, EXPLAIN_LANGS, langInfo, langName, langCode, dictLinks, isLangTag, canonLang } from "./langs.js";
import { schedule, ivlLabel } from "./srs.js";

/* ---------------- Constants and state ---------------- */

const CFG = window.PPP_CONFIG || {};
const LS = {
  firebase: "ppp_firebase_config",
  api: "ppp_anthropic_key",
  theme: "ppp_theme",
  ui: "ppp_ui_lang",
};
const SETTINGS_VERSION = 2;
const DEFAULTS = {
  v: SETTINGS_VERSION,
  size: 21,
  theme: "light",
  uiLang: "en",
  explainLang: "en",
  studyLang: "es",
  highlight: "unlearned",
  cardModel: "claude-opus-5-5",
  cardEffort: "high",
  showThinking: true,
  haikuThinking: false,
  autoCard: false,
  dictModel: "claude-haiku-5-5",
  autoDict: true,
  reviewNew: 20,
  share: true, // add my translations and analyses to the shared library
  liked: [], // ids of shared explanations I liked
  lastChapter: null,
  spent: 0,
};
// Translations and cards made before explanation languages existed were written in Russian.
const LEGACY_XL = "ru";
const HL_ORDER = ["all", "unlearned", "none"];
const MOBILE_MAX = 759;
const DICT_BATCH = 60;
const REVIEW_MAX_DUE = 200;
const REVIEW_NEW_OPTIONS = [5, 10, 15, 20, 30, 50, 100];
const DICT_FLUSH = 5; // save quick translations every 5 batches instead of after each one
const LIKED_MAX = 1000;
const FACT_EMOJI = { funny: "😄", sad: "🥀", creepy: "👻", surprising: "✨", historical: "📜" };

const S = {
  db: null,
  email: "",
  bound: false,
  settings: { ...DEFAULTS },
  lang: "es", // active study language
  panelLang: null, // language shown in the vocabulary and progress panels
  chapters: [],
  chapter: null,
  st: null,
  chapterWords: new Map(),
  vocab: new Map(), // lang -> Map(word -> light row)
  full: new Map(), // wkey -> full row
  sel: null, // { w, lang, sid, ti, surface }
  panel: { open: false, mode: "word" },
  editing: false,
  regenOpen: false,
  gen: new Map(),
  genErr: new Map(),
  ctxJob: null,
  ctxErr: null,
  quickBusy: new Set(),
  quickErr: new Map(),
  dict: { running: false, done: 0, total: 0, token: null },
  bulk: { running: false, done: 0, total: 0, token: null },
  vfilter: { q: "", level: 0 },
  renderedWord: null,
  review: null,
  voiceWarned: new Set(),
  isAdmin: false,
  profile: null,
  lib: new Map(), // wkey -> shared explanations of that word (array), or "loading"
  libOpen: false, // the word panel shows the library list even though a card exists
  libMore: new Set(), // shared ids expanded in the list
  sharedCtx: new Map(), // lang|xl|sentence|word -> shared "why here", or null when there is none
  admin: null, // admin panel data
  view: "home", // "home" (the library) or "read"
  homeQ: "", // search on the home screen
  homeLang: "", // language filter on the home screen; "" = all
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
const apiKey = () => localStorage.getItem(LS.api) || "";
const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${(n || 0).toFixed(2)}`);
const fmtInt = (n) => Number(n || 0).toLocaleString(uiLang());
const chapterTitle = (id) => S.chapters.find((c) => c.id === id)?.title || "";
const skel = (n) =>
  Array.from({ length: n }, (_, i) => `<div class="pp-sk" style="width:${[92, 78, 86, 64, 82, 70][i % 6]}%"></div>`).join("");

const wkey = (lang, w) => `${lang}\t${w}`;
function wordsOf(lang = S.lang) {
  let m = S.vocab.get(lang);
  if (!m) S.vocab.set(lang, (m = new Map()));
  return m;
}
const blankRow = (w, lang) => ({ word: w, lang, level: 5, quick: null, has_card: false, first_chapter: null, learned_at: null, srs: null });
const rowOf = (w, lang = S.lang) => wordsOf(lang).get(w) || blankRow(w, lang);
const setRow = (row) => wordsOf(row.lang).set(row.word, row);
const selLang = () => S.sel?.lang || S.lang;
const isSelected = (w, lang) => !!S.sel && S.sel.w === w && S.sel.lang === lang && S.panel.open && S.panel.mode === "word";
const xl = () => S.settings.explainLang;
const sharing = () => S.settings.share !== false;
const liked = (id) => (S.settings.liked || []).includes(id);
const ctxKey = (lang, x, sentence, w) => `${lang}|${x}|${sentence}|${w}`;
const quickXl = (q) => q?.xl || LEGACY_XL;
const cardXl = (card) => card?.meta?.xl || LEGACY_XL;
// A quick translation is missing, or written in another explanation language (and not typed by hand).
const needsQuick = (row) => !row.quick || (!row.quick.manual && quickXl(row.quick) !== xl());
const readerLangAttrs = (lang) => `lang="${esc(lang)}"${langInfo(lang).rtl ? ' dir="rtl"' : ""}`;

let toastTimer;
function toast(msg, ms = 4200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function applyTheme(theme) {
  const v = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = v;
  localStorage.setItem(LS.theme, v);
}

function applyUiLang(code) {
  setUiLang(code);
  localStorage.setItem(LS.ui, uiLang());
}

let settingsTimer;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    S.db?.saveSettings(S.settings).catch((e) => toast(t("toast.settingsNotSaved", { msg: e.message })));
  }, 800);
}

function addSpent(cost) {
  if (!cost) return;
  S.settings.spent = (S.settings.spent || 0) + cost;
  saveSettingsSoon();
}

/* ---------------- Speech ---------------- */

let voices = [];
function loadVoices() {
  try {
    voices = window.speechSynthesis?.getVoices() || [];
  } catch {
    voices = [];
  }
}
if ("speechSynthesis" in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text, lang) {
  if (!("speechSynthesis" in window)) return toast(t("toast.noSpeech"));
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    if (!voices.length) loadVoices();
    const tag = langInfo(lang).tts;
    const base = tag.split("-")[0].toLowerCase();
    const norm = (v) => (v.lang || "").replace("_", "-").toLowerCase();
    const voice = voices.find((v) => norm(v) === tag.toLowerCase()) || voices.find((v) => norm(v).startsWith(base));
    const u = new SpeechSynthesisUtterance(text);
    u.lang = tag;
    u.rate = 0.9;
    if (voice) u.voice = voice;
    else if (voices.length && !S.voiceWarned.has(base)) {
      S.voiceWarned.add(base);
      toast(t("toast.noVoice", { lang: langName(lang) }), 6000);
    }
    synth.speak(u);
  } catch {
    /* speech is unavailable */
  }
}

/* ---------------- Boot, connection, sign-in ---------------- */

export async function boot() {
  applyUiLang(localStorage.getItem(LS.ui) || DEFAULTS.uiLang);
  applyTheme(localStorage.getItem(LS.theme) || "light");
  bindOnce();
  const config = firebaseConfig();
  if (!config) return renderSetup();
  if (!S.db) {
    let makeDb;
    try {
      // A stalled CDN would otherwise leave "Loading…" on screen forever.
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000));
      ({ makeDb } = await Promise.race([import("./db.js"), timeout]));
    } catch {
      return renderMessage(t("boot.libFailed"), t("boot.libFailedText"));
    }
    try {
      S.db = makeDb(config);
    } catch (e) {
      return renderSetup(t("setup.connectFailed", { msg: e.message }));
    }
  }
  const session = await S.db.session().catch(() => null);
  if (!session) return renderLogin();
  return startApp();
}

function uiLangSwitchHTML() {
  return `<div class="pp-ui-switch" role="group" aria-label="${esc(t("set.uiLang"))}">${UI_LANGS.map(
    ([code, label]) =>
      `<button class="pp-link${code === uiLang() ? " on" : ""}" data-act="ui-lang" data-val="${code}" lang="${code}">${esc(label)}</button>`
  ).join("")}</div>`;
}

function authShell(inner) {
  return `<main class="pp-auth"><div class="pp-auth-card">
    <div class="pp-brand"><span class="pp-logo" aria-hidden="true">ñ</span><span class="pp-brand-t">Palabra por palabra</span></div>
    ${inner}
    ${uiLangSwitchHTML()}
  </div></main>`;
}

function renderMessage(title, text) {
  $("#app").innerHTML = authShell(`<h1 class="pp-auth-h">${esc(title)}</h1><p class="pp-lead">${esc(text)}</p>`);
}

const FIREBASE_REQUIRED = ["apiKey", "authDomain", "projectId", "appId"];

// Accepts the snippet from the Firebase console (a JavaScript object) or plain JSON.
function parseFirebaseConfig(text) {
  const out = {};
  for (const m of String(text).matchAll(/["']?(\w+)["']?\s*:\s*["'`]([^"'`]+)["'`]/g)) out[m[1]] = m[2].trim();
  return out;
}

function firebaseConfig() {
  if (FIREBASE_REQUIRED.every((f) => CFG.FIREBASE?.[f])) return CFG.FIREBASE;
  try {
    const saved = JSON.parse(localStorage.getItem(LS.firebase) || "null");
    return saved && FIREBASE_REQUIRED.every((f) => saved[f]) ? saved : null;
  } catch {
    return null;
  }
}

function renderSetup(err = "") {
  $("#app").innerHTML = authShell(`
    <h1 class="pp-auth-h">${esc(t("setup.title"))}</h1>
    <p class="pp-lead">${esc(t("setup.lead"))}</p>
    ${err ? `<p class="pp-error-line">${esc(err)}</p>` : ""}
    <form id="setup-form" class="pp-form-plain">
      <label class="pp-label" for="su-config">${esc(t("setup.configLabel"))}</label>
      <textarea class="pp-input pp-code" id="su-config" rows="8" required autocomplete="off" spellcheck="false" placeholder="const firebaseConfig = {&#10;  apiKey: &quot;AIza…&quot;,&#10;  authDomain: &quot;…firebaseapp.com&quot;,&#10;  projectId: &quot;…&quot;,&#10;  appId: &quot;1:…&quot;&#10;};"></textarea>
      <button class="pp-primary" type="submit">${esc(t("setup.connect"))}</button>
    </form>`);
  $("#setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#su-config").value;
    if (/private_key|service_account/.test(text)) return renderSetup(t("setup.serviceAccount"));
    if (/sk-ant-/.test(text)) return renderSetup(t("setup.anthropicKey"));
    const config = parseFirebaseConfig(text);
    if (!FIREBASE_REQUIRED.every((f) => config[f])) return renderSetup(t("setup.badConfig"));
    localStorage.setItem(LS.firebase, JSON.stringify(config));
    boot();
  });
}

// Returns the message to show, or "" when there is nothing to report (the user closed the Google window).
function loginError(er, method = "password") {
  const code = String(er?.code || "");
  const m = String(er?.message || er);
  if (/popup-closed-by-user|cancelled-popup-request|user-cancelled/.test(code)) return "";
  if (code.includes("popup-blocked")) return t("login.popupBlocked");
  if (code.includes("unauthorized-domain")) return t("login.unauthorizedDomain", { domain: location.hostname });
  if (code.includes("admin-restricted-operation")) return t("login.signupDisabled");
  if (code.includes("account-exists-with-different-credential")) return t("login.otherMethod");
  if (/invalid login/i.test(m)) return t("login.invalid");
  if (code.includes("operation-not-allowed")) return t(method === "google" ? "login.googleNotEnabled" : "login.notEnabled");
  if (code.includes("api-key") || code.includes("invalid-api-key")) return t("login.badConfig");
  if (code.includes("too-many-requests")) return t("login.tooMany");
  if (code.includes("network-request-failed")) return t("login.network");
  return t("login.failed", { msg: m });
}

function renderLogin(err = "") {
  const fromConfig = FIREBASE_REQUIRED.every((f) => CFG.FIREBASE?.[f]);
  $("#app").innerHTML = authShell(`
    <h1 class="pp-auth-h">${esc(t("login.title"))}</h1>
    <p class="pp-lead">${esc(t("login.lead"))}</p>
    ${err ? `<p class="pp-error-line">${esc(err)}</p>` : ""}
    <button class="pp-google" type="button" id="li-google">${I.google}<span>${esc(t("login.google"))}</span></button>
    <div class="pp-or"><span>${esc(t("login.or"))}</span></div>
    <form id="login-form" class="pp-form-plain">
      <label class="pp-label" for="li-email">${esc(t("login.email"))}</label>
      <input class="pp-input" id="li-email" type="email" required autocomplete="username">
      <label class="pp-label" for="li-pass">${esc(t("login.password"))}</label>
      <input class="pp-input" id="li-pass" type="password" required autocomplete="current-password">
      <button class="pp-primary" type="submit" id="li-btn">${esc(t("login.submit"))}</button>
    </form>
    <p class="pp-note pp-privacy">${esc(t("login.privacy"))}</p>
    ${fromConfig ? "" : `<button class="pp-link pp-auth-alt" data-act="reset-conn">${esc(t("login.otherDb"))}</button>`}`);
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#li-btn");
    btn.disabled = true;
    btn.textContent = t("login.busy");
    try {
      await S.db.signIn($("#li-email").value.trim(), $("#li-pass").value);
      await startApp();
    } catch (er) {
      renderLogin(loginError(er));
    }
  });
  $("#li-google").addEventListener("click", async () => {
    const btn = $("#li-google");
    btn.disabled = true;
    try {
      await S.db.signInWithGoogle();
      await startApp();
    } catch (er) {
      const msg = loginError(er, "google");
      if (msg) renderLogin(msg);
      else btn.disabled = false;
    }
  });
}

function shellHTML() {
  return `
  <div class="pp-shell" id="shell">
    <header class="pp-top">
      <a class="pp-brand" href="#/" title="${esc(t("home.title"))}"><span class="pp-logo" aria-hidden="true">ñ</span><span class="pp-brand-t">Palabra por palabra</span></a>
      <span class="pp-lang-badge" id="lang-badge"></span>
      <div class="pp-select-wrap" id="chapter-picker" hidden>
        <select class="pp-select" id="chapter-select" aria-label="${esc(t("top.chapter"))}"></select>
        <span class="pp-select-ico">${I.down}</span>
      </div>
      <div class="pp-actions">
        <span class="pp-pill" id="top-progress" hidden></span>
        <button class="pp-hl-btn" data-act="cycle-highlight" id="hl-btn" title="${esc(t("top.highlight"))}">${I.highlight}<span id="hl-label"></span></button>
        <button class="pp-icon-btn" data-act="add-chapter" title="${esc(t("top.add"))}" aria-label="${esc(t("top.add"))}">${I.plus}</button>
        <button class="pp-icon-btn" data-act="review" title="${esc(t("top.review"))}" aria-label="${esc(t("top.review"))}">${I.cards}<span class="pp-count" id="review-count" hidden></span></button>
        <button class="pp-icon-btn" data-act="panel" data-mode="vocab" title="${esc(t("panel.vocab"))}" aria-label="${esc(t("panel.vocab"))}">${I.book}<span class="pp-count" id="vocab-count" hidden></span></button>
        <button class="pp-icon-btn" data-act="panel" data-mode="progress" title="${esc(t("panel.progress"))}" aria-label="${esc(t("panel.progress"))}">${I.chart}</button>
        <button class="pp-icon-btn" data-act="panel" data-mode="settings" title="${esc(t("panel.settings"))}" aria-label="${esc(t("panel.settings"))}">${I.gear}</button>
        <button class="pp-icon-btn" id="admin-btn" data-act="panel" data-mode="admin" title="${esc(t("panel.admin"))}" aria-label="${esc(t("panel.admin"))}"${S.isAdmin ? "" : " hidden"}>${I.shield}</button>
      </div>
    </header>
    <main id="main"></main>
  </div>
  <aside class="pp-drawer" id="drawer" aria-hidden="true">
    <div class="pp-grab"></div>
    <div class="pp-drawer-h"><span id="drawer-title"></span><button class="pp-icon-btn sm" data-act="close-panel" aria-label="${esc(t("panel.close"))}">${I.x}</button></div>
    <div class="pp-drawer-b" id="drawer-body"></div>
  </aside>
  <div id="modal-root"></div>
  <div class="pp-toast" id="toast" role="status" hidden></div>`;
}

function setMain(html) {
  const m = $("#main");
  if (m) m.innerHTML = html;
}

function loadingHTML(key) {
  return `<div class="pp-boot"><span class="pp-spin">${I.loader}</span><span>${esc(t(key))}</span></div>`;
}

function migrateSettings(saved) {
  const s = { ...DEFAULTS, ...(saved || {}) };
  if (!saved || (saved.v || 1) < SETTINGS_VERSION) {
    // Version 1 used older models and had no language settings.
    const newer = {
      "claude-opus-5": "claude-opus-5-5",
      "claude-sonnet-5": "claude-sonnet-5-5",
      "claude-haiku-4-5": "claude-haiku-5-5",
      "claude-haiku-4-5-20251001": "claude-haiku-5-5",
    };
    s.cardModel = newer[s.cardModel] || s.cardModel;
    s.dictModel = newer[s.dictModel] || s.dictModel;
    if (!saved?.uiLang) s.uiLang = uiLang();
    s.v = SETTINGS_VERSION;
  }
  s.size = Math.min(30, Math.max(16, Number(s.size) || DEFAULTS.size));
  if (!HL_ORDER.includes(s.highlight)) s.highlight = DEFAULTS.highlight;
  if (!["light", "dark"].includes(s.theme)) s.theme = DEFAULTS.theme;
  if (!REVIEW_NEW_OPTIONS.includes(Number(s.reviewNew))) s.reviewNew = DEFAULTS.reviewNew;
  s.reviewNew = Number(s.reviewNew);
  if (!Array.isArray(s.liked)) s.liked = [];
  return s;
}

async function startApp() {
  $("#app").innerHTML = shellHTML();
  setMain(loadingHTML("boot.loading"));
  try {
    const [chapters, words, saved, email, role] = await Promise.all([
      S.db.listChapters(),
      S.db.loadWords(),
      S.db.loadSettings(),
      S.db.userEmail().catch(() => ""),
      S.db.loadRole().catch(() => ({ profile: null, admin: false })),
    ]);
    S.isAdmin = role.admin;
    S.profile = role.profile;
    S.chapters = chapters.map((c) => ({ ...c, lang: c.lang || "es" }));
    S.vocab = new Map();
    for (const r of words) setRow({ ...r, lang: r.lang || "es" });
    S.settings = migrateSettings(saved);
    if (!saved || (saved.v || 1) < SETTINGS_VERSION) saveSettingsSoon();
    S.email = email;
    if (S.settings.uiLang !== uiLang()) {
      applyUiLang(S.settings.uiLang);
      $("#app").innerHTML = shellHTML();
    }
    $("#admin-btn").hidden = !S.isAdmin;
    // Keeps the admin's list of users current; never blocks the app.
    S.db.saveProfile({ words: words.length, cards: words.filter((r) => r.has_card).length }).catch(() => {});
    const last = S.chapters.find((c) => c.id === S.settings.lastChapter) || S.chapters.at(-1);
    S.lang = last?.lang || S.settings.studyLang || "es";
    applyReaderSettings();
    updateChapterSelect();
    updateVocabCount();
    updateReviewCount();
    route();
  } catch (e) {
    // Firebase setup mistakes get their own explanation.
    const code = String(e.code || "");
    const kind = code.includes("permission-denied")
      ? "rules"
      : code.includes("not-found") || /database .* does not exist/i.test(e.message)
        ? "noDb"
        : code.includes("unavailable")
          ? "offline"
          : "load";
    setMain(`<div class="pp-empty"><div class="pp-empty-in">
      <h1 class="pp-hero">${esc(t(`err.${kind}Title`))}</h1>
      <p class="pp-lead">${esc(t(`err.${kind}`))}</p>
      <p class="pp-note">${esc(e.message)}</p>
      <div class="pp-row"><button class="pp-primary" data-act="reload">${esc(t("err.reload"))}</button><button class="pp-soft-btn" data-act="logout">${esc(t("account.logout"))}</button></div>
    </div></div>`);
  }
}

// After switching the interface language: redraw everything in place.
function rerenderAll() {
  const panel = { ...S.panel };
  $("#app").innerHTML = shellHTML();
  applyReaderSettings();
  updateChapterSelect();
  updateVocabCount();
  updateReviewCount();
  updateTopProgress();
  if (S.chapter && S.st) renderChapter();
  else renderEmpty();
  if (panel.open) openPanel(panel.mode);
}

/* ---------------- Events ---------------- */

function bindOnce() {
  if (S.bound) return;
  S.bound = true;
  const app = $("#app");
  app.addEventListener("click", onClick);
  app.addEventListener("change", onChange);
  app.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
  setInterval(tick, 1000);
  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", savePosSoon, { passive: true });
}

const ACTIONS = {
  reload: () => location.reload(),
  "reset-conn": () => {
    localStorage.removeItem(LS.firebase);
    location.reload();
  },
  "ui-lang": (a) => {
    applyUiLang(a.dataset.val);
    if (S.chapters.length || $("#shell")) {
      S.settings.uiLang = uiLang();
      saveSettingsSoon();
      rerenderAll();
    } else boot();
  },
  panel: (a) => togglePanel(a.dataset.mode),
  "close-panel": () => closePanel(),
  "add-chapter": () => openAddChapter(),
  "add-submit": () => submitChapter(),
  "modal-close": () => closeModal(),
  "modal-backdrop": (a, e) => {
    if (e.target === a) closeModal();
  },
  "cycle-highlight": () => {
    const i = HL_ORDER.indexOf(S.settings.highlight);
    S.settings.highlight = HL_ORDER[(i + 1) % HL_ORDER.length];
    applyReaderSettings();
    saveSettingsSoon();
    toast(t("hl.label", { mode: t(`hl.${S.settings.highlight}`) }), 1800);
    if (S.panel.open && S.panel.mode === "settings") renderSettings();
  },
  level: (a) => S.sel && setLevel(S.sel.w, Number(a.dataset.level), S.sel.lang),
  speak: (a) => speak(a.dataset.text, a.dataset.lang || selLang()),
  occ: (a) => jumpOcc(Number(a.dataset.dir)),
  "gen-card": () => generateForSelected(),
  "gen-cancel": () => S.sel && S.gen.get(wkey(S.sel.lang, S.sel.w))?.abort.abort(),
  "regen-open": () => {
    S.regenOpen = true;
    renderWordView();
    $("#regen-wish")?.focus();
  },
  "regen-close": () => {
    S.regenOpen = false;
    renderWordView();
  },
  "regen-go": () => generateForSelected(($("#regen-wish")?.value || "").trim()),
  "regen-xl": () => generateForSelected(),
  "explain-here": () => explainHere(),
  "retry-quick": () => S.sel && ensureQuick(S.sel.w, true, S.sel.lang),
  edit: () => {
    S.editing = true;
    renderWordView();
  },
  "edit-cancel": () => {
    S.editing = false;
    renderWordView();
  },
  "edit-save": () => saveEdit(),
  "open-word": (a) => openWordFromList(a.dataset.w, a.dataset.lang),
  "vocab-level": (a) => {
    S.vfilter.level = Number(a.dataset.level);
    renderVocab();
  },
  "prepare-dict": () => prepareDictionary(true),
  "stop-dict": () => stopDictionary(),
  bulk: () => bulkAnalyze(),
  "stop-bulk": () => stopBulk(),
  seg: (a) => {
    S.settings[a.dataset.key] = a.dataset.val;
    applyReaderSettings();
    saveSettingsSoon();
    renderSettings();
  },
  "save-key": () => saveKey(),
  "check-key": () => checkKeyAction(),
  "clear-key": () => {
    if (!confirm(t("key.confirmDelete"))) return;
    localStorage.removeItem(LS.api);
    renderSettings();
  },
  "rename-chapter": (a) => renameChapter(a.dataset.id),
  "chapter-book": (a) => moveToBook(a.dataset.id),
  "home-lang": (a) => {
    S.homeLang = a.dataset.val;
    renderHome();
  },
  "delete-chapter": (a) => deleteChapter(a.dataset.id),
  export: () => exportBackup(),
  import: () => $("#import-file")?.click(),
  "reset-spent": () => {
    if (!confirm(t("prog.confirmReset"))) return;
    S.settings.spent = 0;
    saveSettingsSoon();
    renderPanel();
  },
  logout: async () => {
    await S.db.signOut();
    location.reload();
  },
  review: () => openReview(),
  "rv-scope": (a) => {
    S.review.scope = a.dataset.val;
    renderReview();
  },
  "rv-start": () => startReview(),
  "rv-show": () => revealReview(),
  "rv-rate": (a) => rateReview(Number(a.dataset.level)),
  "rv-again": () => {
    S.review = { stage: "start", scope: S.review.scope, lang: S.lang };
    renderReview();
  },
  "rv-close": () => closeModal(),
  // Shared library
  "lib-use": (a) => useShared(a.dataset.id),
  "lib-like": (a) => toggleLike(a.dataset.id),
  "lib-more": (a) => {
    const id = a.dataset.id;
    if (S.libMore.has(id)) S.libMore.delete(id);
    else S.libMore.add(id);
    renderWordView();
  },
  "lib-open": () => {
    S.libOpen = true;
    if (S.sel) loadLibrary(S.sel.w, S.sel.lang, true);
    renderWordView();
  },
  "lib-close": () => {
    S.libOpen = false;
    renderWordView();
  },
  "lib-delete": (a) => deleteShared(a.dataset.id),
  "copy-uid": () => {
    const uid = S.db?.userInfo().uid || "";
    navigator.clipboard?.writeText(uid).then(() => toast(t("account.uidCopied")), () => prompt(t("account.uid"), uid));
  },
  // Admin panel
  "admin-refresh": () => loadAdmin(true),
  "admin-plan": (a) => savePlan(a.dataset.uid),
  "admin-delete": (a) => deleteShared(a.dataset.id),
};

function onClick(e) {
  const word = e.target.closest(".pp-wd[data-w]");
  if (word) return onWordClick(word);
  const a = e.target.closest("[data-act]");
  if (!a) return;
  const fn = ACTIONS[a.dataset.act];
  if (!fn) return;
  if (a.tagName === "BUTTON" || a.tagName === "A") e.preventDefault();
  fn(a, e);
}

// Asks for a language code that is not in the menu. Returns the code or null.
function askLangCode() {
  const raw = prompt(t("lang.askCode"));
  if (!raw || !raw.trim()) return null;
  const code = raw.trim();
  if (!isLangTag(code)) {
    toast(t("lang.badCode", { code }));
    return null;
  }
  return canonLang(code);
}

function onChange(e) {
  const tg = e.target;
  if (tg.id === "chapter-select") return tg.value ? goChapter(tg.value) : goHome();
  if (tg.id === "add-join") return updateAddPreview();
  if (tg.id === "add-lang") {
    if (tg.value === "__other") {
      const code = askLangCode();
      const lang = code || S.lang;
      tg.innerHTML = langOptions(STUDY_LANGS, lang, true);
    }
    $("#add-text")?.setAttribute("lang", tg.value);
    return updateAddPreview();
  }
  if (tg.id === "panel-lang") {
    S.panelLang = tg.value;
    return renderPanel();
  }
  if (tg.id === "import-file") return void importBackup(tg.files?.[0]);
  const k = tg.dataset.set;
  if (!k) return;
  let val = tg.type === "checkbox" ? tg.checked : tg.type === "range" ? Number(tg.value) : tg.value;
  if ((k === "cardModel" || k === "dictModel") && val === "__custom") {
    const id = prompt(t("set.customModelAsk"));
    if (!id || !id.trim()) return renderSettings();
    val = id.trim();
  }
  if (k === "explainLang" && val === "__other") {
    val = askLangCode();
    if (!val) return renderSettings();
  }
  if (k === "reviewNew") val = Number(val);
  S.settings[k] = val;
  if (k === "cardModel") {
    const inf = modelInfo(val);
    if (inf.efforts && !inf.efforts.includes(S.settings.cardEffort)) S.settings.cardEffort = "high";
  }
  saveSettingsSoon();
  if (k === "uiLang") {
    applyUiLang(val);
    return rerenderAll();
  }
  applyReaderSettings();
  if (k === "explainLang") {
    updateChapterStats();
    if (S.sel) patchQuick(S.sel.w, S.sel.lang);
    if (S.settings.autoDict || !apiKey()) prepareDictionary();
  }
  if (["cardModel", "cardEffort", "dictModel", "showThinking", "haikuThinking", "explainLang"].includes(k)) renderSettings();
}

let previewTimer;
function onInput(e) {
  const tg = e.target;
  if (tg.dataset.role === "vocab-search") {
    S.vfilter.q = tg.value;
    renderVocabList();
  } else if (tg.dataset.role === "home-search") {
    S.homeQ = tg.value;
    renderHomeList();
  } else if (tg.id === "add-text") {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateAddPreview, 150);
  } else if (tg.dataset.set === "size") {
    S.settings.size = Number(tg.value);
    applyReaderSettings();
    const out = $("#size-out");
    if (out) out.textContent = `${tg.value} px`;
  }
}

function onKey(e) {
  if (!S.db) return;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (S.review && $("#modal-root .pp-rv")) {
    if (e.key === "Escape") return closeModal();
    if (typing || e.metaKey || e.ctrlKey || e.altKey || S.review.stage !== "card") return;
    if (!S.review.revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      revealReview();
    } else if (S.review.revealed && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      rateReview(Number(e.key));
    }
    return;
  }
  if (e.key === "Escape") {
    if ($("#modal-root .pp-modal")) closeModal();
    else if (S.panel.open && !typing) closePanel();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!S.panel.open || S.panel.mode !== "word" || !S.sel || S.editing) return;
  if (/^[1-5]$/.test(e.key)) {
    e.preventDefault();
    setLevel(S.sel.w, Number(e.key), S.sel.lang);
  } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.sel.sid != null) {
    e.preventDefault();
    moveSelection(e.key === "ArrowRight" ? 1 : -1);
  }
}

let ticks = 0;
function tick() {
  if (++ticks % 60 === 0) updateReviewCount();
  if (!S.sel) return;
  const job = S.gen.get(wkey(S.sel.lang, S.sel.w));
  const el = $("#gen-elapsed");
  if (job && el) el.textContent = t("gen.seconds", { n: Math.round((Date.now() - job.started) / 1000) });
}

/* ---------------- Chapters and reading ---------------- */

function chapterLangs() {
  return [...new Set(S.chapters.map((c) => c.lang))];
}

function updateChapterSelect() {
  const sel = $("#chapter-select");
  if (!sel) return;
  $("#chapter-picker").hidden = !S.chapters.length;
  const langs = chapterLangs();
  const reading = S.view === "read";
  const opt = (c) =>
    `<option value="${esc(c.id)}"${reading && S.chapter?.id === c.id ? " selected" : ""}>${esc(bookOf(c) ? `${bookOf(c)} · ${c.title}` : c.title)}</option>`;
  sel.innerHTML =
    `<option value=""${reading ? "" : " selected"}>${esc(t("home.title"))}</option>` +
    (langs.length > 1
      ? langs
          .map((l) => `<optgroup label="${esc(langName(l))}">${S.chapters.filter((c) => c.lang === l).map(opt).join("")}</optgroup>`)
          .join("")
      : S.chapters.map(opt).join(""));
  const badge = $("#lang-badge");
  if (badge) {
    badge.textContent = langCode(S.lang);
    badge.title = langName(S.lang);
  }
}

function updateVocabCount() {
  const el = $("#vocab-count");
  if (!el) return;
  let n = 0;
  for (const r of wordsOf(S.lang).values()) if (r.level === 1) n++;
  el.hidden = n === 0;
  el.textContent = n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
  el.title = t("vocab.learnedTitle", { n });
}

function readerClass() {
  const cjk = S.chapter && langInfo(S.chapter.lang).noSpace ? " is-cjk" : "";
  return `pp-reader hl-${S.settings.highlight}${cjk}`;
}

function applyReaderSettings() {
  applyTheme(S.settings.theme);
  const r = $("#reader");
  if (r) {
    r.style.fontSize = `${S.settings.size}px`;
    r.className = readerClass();
  }
  $$(".pp-sent[data-hl]").forEach((p) => (p.className = `pp-sent hl-${S.settings.highlight}`));
  const label = $("#hl-label");
  if (label) label.textContent = t("hl.label", { mode: t(`hl.${S.settings.highlight}`) });
}

async function openChapter(id) {
  if (S.editing && !confirm(t("confirm.leaveEdit"))) {
    history.replaceState(null, "", S.view === "read" && S.chapter ? `#/read/${S.chapter.id}` : "#/");
    return updateChapterSelect();
  }
  S.view = "read";
  stopDictionary(true);
  setMain(loadingHTML("reader.opening"));
  try {
    const ch = await S.db.getChapter(id);
    ch.lang = ch.lang || "es";
    const langChanged = S.lang !== ch.lang;
    S.chapter = ch;
    S.lang = ch.lang;
    S.st = buildStructure(ch.paragraphs, ch.lang);
    S.chapterWords.set(id, new Set(S.st.firstOcc.keys()));
    S.editing = false;
    if (S.panel.open && S.panel.mode === "word") closePanel(true);
    S.sel = null;
    S.settings.lastChapter = id;
    S.settings.studyLang = ch.lang;
    saveSettingsSoon();
    renderChapter();
    updateChapterSelect();
    updateVocabCount();
    updateReviewCount();
    if (langChanged) {
      S.panelLang = null;
      if (S.panel.open) renderPanel();
    }
    restorePos(id);
    if (S.settings.autoDict || !apiKey()) prepareDictionary();
  } catch (e) {
    setMain(`<div class="pp-empty"><div class="pp-empty-in"><h1 class="pp-hero">${esc(t("reader.openFailed"))}</h1><p class="pp-lead">${esc(e.message)}</p></div></div>`);
  }
}

function renderEmpty() {
  S.view = "home";
  S.chapter = null;
  S.st = null;
  setMain(`<div class="pp-empty"><div class="pp-empty-in">
    <h1 class="pp-hero">${esc(t("empty.title"))}</h1>
    <p class="pp-lead">${esc(t("empty.lead"))}</p>
    ${apiKey() ? "" : `<p class="pp-note">${th("empty.noKey", { settings: `<button class="pp-link" data-act="panel" data-mode="settings">${esc(t("empty.settingsLink"))}</button>` }, ["settings"])}</p>`}
    ${addFormHTML(true)}
  </div></div>`);
  updateChapterSelect();
}

function renderChapter() {
  const st = S.st;
  const lang = S.chapter.lang;
  const html = st.paras
    .map((p) => {
      let inner = "";
      for (const s of p.sents) {
        for (let ti = 0; ti < s.tokens.length; ti++) {
          const tk = s.tokens[ti];
          inner += tk.w
            ? `<span class="pp-wd l${rowOf(tk.w, lang).level}" data-w="${esc(tk.w)}" data-s="${s.sid}" data-i="${ti}">${esc(tk.t)}</span>`
            : esc(tk.t);
        }
      }
      return p.heading ? `<h1 class="pp-heading">${inner}</h1>` : `<p class="pp-p">${inner}</p>`;
    })
    .join("");
  setMain(`
    <div class="pp-meta">
      <div class="pp-meta-row"><p class="pp-stats" id="chap-stats"></p><div class="pp-row" id="chap-actions"></div></div>
      <div class="pp-levelbar" id="chap-levelbar" aria-hidden="true"></div>
    </div>
    <article class="${readerClass()}" id="reader" ${readerLangAttrs(lang)} style="font-size:${Number(S.settings.size)}px">${html}</article>
    <div class="pp-end"><span>${esc(t("reader.end"))}</span>${endLinksHTML()}</div>`);
  updateChapterStats();
}

function endLinksHTML() {
  const next = nextChapter(S.chapter);
  const forward = next
    ? `<a class="pp-primary" href="#/read/${esc(next.id)}">${esc(t("reader.next", { title: next.title }))} ${I.right}</a>`
    : `<button class="pp-link" data-act="add-chapter">${esc(t("reader.addNext"))}</button>`;
  return `${forward}<a class="pp-link" href="#/">${esc(t("reader.toLibrary"))}</a>`;
}

function levelCounts(words, lang = S.lang) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const w of words) c[rowOf(w, lang).level]++;
  return c;
}

function levelBarHTML(c) {
  return [1, 2, 3, 4, 5]
    .map((l) => (c[l] ? `<i class="lb${l}" style="flex-grow:${c[l]}" title="${esc(t("level.barTitle", { l, n: c[l] }))}"></i>` : ""))
    .join("");
}

function updateChapterStats() {
  if (!S.st || !$("#chap-stats")) return;
  const lang = S.chapter.lang;
  const words = [...S.st.firstOcc.keys()];
  const c = levelCounts(words, lang);
  const total = words.length;
  $("#chap-stats").innerHTML = th("reader.stats", { learned: c[1], n: total, studying: c[2] + c[3] + c[4] });
  $("#chap-levelbar").innerHTML = levelBarHTML(c);
  const noQuick = words.filter((w) => needsQuick(rowOf(w, lang))).length;
  const unanalyzed = words.filter((w) => rowOf(w, lang).level > 1 && !rowOf(w, lang).has_card).length;
  let actions = "";
  if (S.dict.running) actions += `<button class="pp-soft-btn" data-act="stop-dict">${esc(t("reader.stopDict"))}</button>`;
  else if (noQuick && apiKey())
    actions += `<button class="pp-soft-btn" data-act="prepare-dict" title="${esc(t("reader.prepareDictTitle"))}">${I.book} ${esc(t("reader.prepareDict", { n: noQuick }))}</button>`;
  if (S.bulk.running) actions += `<button class="pp-soft-btn" data-act="stop-bulk">${esc(t("reader.stopBulk"))}</button>`;
  else if (unanalyzed && apiKey())
    actions += `<button class="pp-soft-btn" data-act="bulk" title="${esc(t("reader.bulkTitle"))}">${I.sparkles} ${esc(t("reader.bulk", { n: unanalyzed }))}</button>`;
  $("#chap-actions").innerHTML = actions;
}

function updateTopProgress() {
  const el = $("#top-progress");
  if (!el) return;
  const parts = [];
  if (S.dict.running) parts.push(t("top.dictProgress", { done: S.dict.done, total: S.dict.total }));
  if (S.bulk.running) parts.push(t("top.bulkProgress", { done: S.bulk.done, total: S.bulk.total }));
  el.hidden = !parts.length;
  el.innerHTML = parts.length ? `<span class="pp-spin">${I.loader}</span>${esc(parts.join(", "))}` : "";
}

function refreshWordSpans(w, lang) {
  if (S.chapter?.lang !== lang) return;
  const lvl = rowOf(w, lang).level;
  $$(`.pp-wd[data-w="${cssEsc(w)}"]`).forEach((el) => {
    el.classList.remove("l1", "l2", "l3", "l4", "l5");
    el.classList.add(`l${lvl}`);
  });
}

function markSelection() {
  $$(".pp-reader .is-cur, .pp-reader .is-same").forEach((el) => el.classList.remove("is-cur", "is-same"));
  if (!S.sel || !S.panel.open || S.panel.mode !== "word" || S.sel.sid == null) return;
  $$(`.pp-reader .pp-wd[data-w="${cssEsc(S.sel.w)}"]`).forEach((el) =>
    el.classList.add(Number(el.dataset.s) === S.sel.sid && Number(el.dataset.i) === S.sel.ti ? "is-cur" : "is-same")
  );
}

// Scrolls a word in the reader into the visible strip: below the header and, on phones, above the bottom sheet.
function keepVisible(el) {
  const r = el.getBoundingClientRect();
  const head = $(".pp-top");
  const top = (head && getComputedStyle(head).position === "sticky" ? head.offsetHeight : 0) + 12;
  const mobile = window.innerWidth <= MOBILE_MAX;
  const sheet = mobile && S.panel.open ? $("#drawer")?.offsetHeight || 0 : 0;
  const bottom = window.innerHeight - sheet - 12;
  if (r.top >= top && r.bottom <= bottom) return;
  const target = mobile ? top : (top + bottom - r.height) / 2;
  window.scrollBy({ top: r.top - target, behavior: "smooth" });
}

function scrollToToken(sid, ti) {
  const el = $(`.pp-reader [data-s="${sid}"][data-i="${ti}"]`);
  if (el) keepVisible(el);
}

/* ---------------- Navigation and the library home ---------------- */

// Routes: "#/" is the library, "#/read/<chapter id>" is a chapter, so the browser's back button works.
const READ_ROUTE = /^#\/read\/([A-Za-z0-9_-]{1,80})$/;

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
const goChapter = (id) => go(`#/read/${id}`);
const goHome = () => go("#/");

function route() {
  if (!S.db || !$("#shell")) return;
  if (!S.chapters.length) return renderEmpty();
  const id = location.hash.match(READ_ROUTE)?.[1];
  const ch = id && S.chapters.find((c) => c.id === id);
  if (ch) {
    if (S.view !== "read" || S.chapter?.id !== ch.id) openChapter(ch.id);
    return;
  }
  if (location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
  renderHome();
}

// Where you stopped in each chapter, as a share of the page, kept in this browser.
const posKey = (id) => `ppp_pos_${id}`;
function readPos(id) {
  try {
    return Math.min(1, Math.max(0, Number(localStorage.getItem(posKey(id))) || 0));
  } catch {
    return 0;
  }
}
let posTimer;
function savePosSoon() {
  if (S.view !== "read" || !S.chapter) return;
  clearTimeout(posTimer);
  const id = S.chapter.id;
  posTimer = setTimeout(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0 || S.view !== "read" || S.chapter?.id !== id) return;
    try {
      localStorage.setItem(posKey(id), (window.scrollY / max).toFixed(4));
    } catch {
      /* private mode: no reading position, nothing else breaks */
    }
  }, 400);
}
function restorePos(id) {
  const r = readPos(id);
  const max = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo(0, r > 0.01 && max > 0 ? Math.round(r * max) : 0);
}

const bookOf = (c) => String(c?.book || "").trim();
const chaptersInOrder = (list) =>
  [...list].sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.created_at).localeCompare(String(b.created_at)));

// The chapter after this one in the same language and book.
function nextChapter(ch) {
  const same = chaptersInOrder(S.chapters.filter((c) => c.lang === ch.lang && bookOf(c) === bookOf(ch)));
  const i = same.findIndex((c) => c.id === ch.id);
  return i >= 0 ? same[i + 1] || null : null;
}

function chapterProgress(c) {
  const set = S.chapterWords.get(c.id);
  if (!set) return null;
  const counts = levelCounts(set, c.lang);
  return { counts, total: set.size, pct: set.size ? Math.round((counts[1] / set.size) * 100) : 0 };
}

// Word lists of chapters not opened in this session, for their progress bars.
// The text comes from the local cache when possible, so this is usually free.
let homeLoading = false;
async function loadHomeProgress() {
  if (homeLoading) return;
  const todo = S.chapters.filter((c) => !S.chapterWords.has(c.id));
  if (!todo.length) return;
  homeLoading = true;
  let n = 0;
  for (const c of todo) {
    try {
      const full = await S.db.getChapter(c.id);
      S.chapterWords.set(c.id, new Set(buildStructure(full.paragraphs, c.lang).firstOcc.keys()));
    } catch {
      S.chapterWords.set(c.id, new Set());
    }
    if (++n % 6 === 0 && S.view === "home") renderHomeList();
  }
  homeLoading = false;
  if (S.view === "home") renderHomeList();
}

function renderHome() {
  if (!S.chapters.length) return renderEmpty();
  if (S.editing && !confirm(t("confirm.leaveEdit"))) {
    history.replaceState(null, "", S.chapter ? `#/read/${S.chapter.id}` : "#/");
    return;
  }
  S.view = "home";
  S.editing = false;
  if (S.panel.open && S.panel.mode === "word") closePanel(true);
  S.sel = null;
  const last = S.chapters.find((c) => c.id === S.settings.lastChapter);
  let learned = 0;
  for (const m of S.vocab.values()) for (const r of m.values()) if (r.level === 1) learned++;
  const langs = chapterLangs();
  if (S.homeLang && !langs.includes(S.homeLang)) S.homeLang = "";
  const chip = ([v, label]) =>
    `<button class="pp-chip-btn${S.homeLang === v ? " on" : ""}" data-act="home-lang" data-val="${esc(v)}">${esc(label)}</button>`;
  setMain(`<div class="pp-home">
    <header class="pp-home-head">
      <h1 class="pp-hero">${esc(t("home.title"))}</h1>
      <div class="pp-home-stats">
        <button class="pp-stat" data-act="review"><b>${fmtInt(dueCount(S.lang))}</b><span>${esc(t("home.due", { lang: langName(S.lang) }))}</span></button>
        <button class="pp-stat" data-act="panel" data-mode="vocab"><b>${fmtInt(learned)}</b><span>${esc(t("home.learned"))}</span></button>
        <button class="pp-stat" data-act="panel" data-mode="progress"><b>${fmtInt(S.chapters.length)}</b><span>${esc(t("home.texts", { n: S.chapters.length }))}</span></button>
      </div>
    </header>
    ${last ? continueHTML(last) : ""}
    <section class="pp-home-lib" aria-label="${esc(t("home.library"))}">
      <div class="pp-home-tools">
        <label class="pp-search pp-home-search"><input data-role="home-search" value="${esc(S.homeQ)}" placeholder="${esc(t("home.search"))}" aria-label="${esc(t("home.search"))}"></label>
        <button class="pp-primary" data-act="add-chapter">${I.plus}<span>${esc(t("home.add"))}</span></button>
      </div>
      ${langs.length > 1 ? `<div class="pp-filter" role="group" aria-label="${esc(t("home.langFilter"))}">${[["", t("home.allLangs")], ...langs.map((l) => [l, langName(l)])].map(chip).join("")}</div>` : ""}
      <div id="home-list"></div>
    </section>
  </div>`);
  renderHomeList();
  updateChapterSelect();
  window.scrollTo(0, 0);
  loadHomeProgress();
}

function continueHTML(c) {
  const p = chapterProgress(c);
  const read = Math.round(readPos(c.id) * 100);
  const where = [langName(c.lang), bookOf(c), read ? t("home.readPct", { pct: read }) : ""].filter(Boolean).join(" · ");
  return `<a class="pp-continue" href="#/read/${esc(c.id)}">
    <span class="pp-continue-k">${esc(t("home.continue"))}</span>
    <span class="pp-continue-t" ${readerLangAttrs(c.lang)}>${esc(c.title)}</span>
    <span class="pp-note">${esc(where)}</span>
    ${p ? `<span class="pp-levelbar" aria-hidden="true">${levelBarHTML(p.counts)}</span>` : ""}
    <span class="pp-continue-go">${esc(t("home.continueBtn"))} ${I.right}</span>
  </a>`;
}

function renderHomeList() {
  const box = $("#home-list");
  if (!box) return;
  const q = searchKey(S.homeQ.trim());
  const match = (c) => !q || searchKey(c.title).includes(q) || searchKey(bookOf(c)).includes(q);
  let shown = 0;
  const html = chapterLangs()
    .filter((l) => !S.homeLang || l === S.homeLang)
    .map((l) => {
      const list = chaptersInOrder(S.chapters.filter((c) => c.lang === l && match(c)));
      if (!list.length) return "";
      shown += list.length;
      // Books alphabetically, loose texts last.
      const books = [...new Set(list.map(bookOf))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, uiLang()));
      return `<section class="pp-home-lang">
        <h2 class="pp-home-lang-h"><span class="pp-lang-tag">${esc(langCode(l))}</span> ${esc(langName(l))}</h2>
        ${books.map((b) => bookHTML(b, list.filter((c) => bookOf(c) === b))).join("")}
      </section>`;
    })
    .join("");
  box.innerHTML = shown ? html : `<p class="pp-note">${esc(t("home.nothing"))}</p>`;
}

function bookHTML(book, list) {
  return `<div class="pp-book">
    <div class="pp-book-h"><h3>${esc(book || t("home.looseTexts"))}</h3><span class="pp-note">${esc(t("home.bookMeta", { n: list.length }))}</span></div>
    <div class="pp-ch-grid">${list.map(chapterCardHTML).join("")}</div>
  </div>`;
}

function chapterCardHTML(c) {
  const p = chapterProgress(c);
  const read = Math.round(readPos(c.id) * 100);
  const words = p ? p.total : c.words;
  const meta = [words ? t("home.words", { n: words }) : "", fmtDate(c.created_at)].filter(Boolean).join(" · ");
  return `<article class="pp-ch-card${c.id === S.settings.lastChapter ? " is-last" : ""}">
    <a class="pp-ch-open" href="#/read/${esc(c.id)}">
      <span class="pp-ch-title" ${readerLangAttrs(c.lang)}>${esc(c.title)}</span>
      <span class="pp-note">${esc(meta)}</span>
      <span class="pp-levelbar" aria-hidden="true">${p ? levelBarHTML(p.counts) : ""}</span>
      <span class="pp-ch-foot"><span>${p ? esc(t("home.known", { pct: p.pct })) : ""}</span><span>${read ? esc(t("home.readPct", { pct: read })) : ""}</span></span>
    </a>
    <div class="pp-ch-tools">
      <button class="pp-icon-btn sm" data-act="chapter-book" data-id="${esc(c.id)}" title="${esc(t("home.moveBook"))}" aria-label="${esc(t("home.moveBook"))}">${I.folder}</button>
      <button class="pp-icon-btn sm" data-act="rename-chapter" data-id="${esc(c.id)}" title="${esc(t("chapters.rename"))}" aria-label="${esc(t("chapters.rename"))}">${I.edit}</button>
      <button class="pp-icon-btn sm" data-act="delete-chapter" data-id="${esc(c.id)}" title="${esc(t("chapters.delete"))}" aria-label="${esc(t("chapters.delete"))}">${I.trash}</button>
    </div>
  </article>`;
}

async function moveToBook(id) {
  const ch = S.chapters.find((c) => c.id === id);
  if (!ch) return;
  const name = prompt(t("home.moveAsk"), bookOf(ch));
  if (name === null) return;
  const book = name.trim().slice(0, 120);
  try {
    await S.db.setChapterBook(id, book);
    ch.book = book;
    if (S.chapter?.id === id) S.chapter.book = book;
    updateChapterSelect();
    if (S.view === "home") renderHomeList();
  } catch (e) {
    toast(t("chapters.renameFailed", { msg: e.message }));
  }
}

/* ---------------- Adding a chapter ---------------- */

function langOptions(list, selected, withOther) {
  const codes = !selected || list.includes(selected) ? list : [...list, selected];
  return (
    codes
      .map((c) => ({ c, n: langName(c) }))
      .sort((a, b) => a.n.localeCompare(b.n, uiLang()))
      .map(({ c, n }) => `<option value="${esc(c)}"${c === selected ? " selected" : ""}>${esc(n)}</option>`)
      .join("") + (withOther ? `<option value="__other">${esc(t("lang.other"))}</option>` : "")
  );
}

function addFormHTML(first) {
  return `<div class="pp-form">
    <div class="pp-form-grid">
      <div><label class="pp-label" for="add-lang">${esc(t("add.lang"))}</label>
        <select class="pp-input" id="add-lang">${langOptions(STUDY_LANGS, S.lang, true)}</select></div>
      <div><label class="pp-label" for="add-book">${esc(t("add.book"))}</label>
        <input class="pp-input" id="add-book" list="add-book-list" maxlength="120" value="${esc(S.view === "read" ? bookOf(S.chapter) : "")}" placeholder="${esc(t("add.bookPlaceholder"))}">
        <datalist id="add-book-list">${[...new Set(S.chapters.map(bookOf).filter(Boolean))].map((b) => `<option value="${esc(b)}">`).join("")}</datalist></div>
      <div><label class="pp-label" for="add-title">${esc(t("add.titleLabel"))}</label>
        <input class="pp-input" id="add-title" maxlength="120" placeholder="${esc(t("add.titlePlaceholder"))}"></div>
    </div>
    <label class="pp-label" for="add-text">${esc(t("add.text"))}</label>
    <textarea class="pp-textarea" id="add-text" lang="${esc(S.lang)}" placeholder="${esc(t("add.textPlaceholder"))}"></textarea>
    <label class="pp-check"><input type="checkbox" id="add-join" checked> ${esc(t("add.join"))}</label>
    <div class="pp-form-foot">
      <p class="pp-note" id="add-preview">${esc(t("add.previewEmpty"))}</p>
      <div class="pp-row">
        ${first ? "" : `<button class="pp-soft-btn" data-act="modal-close">${esc(t("common.cancel"))}</button>`}
        <button class="pp-primary" data-act="add-submit" id="add-submit" disabled>${esc(t("add.submit"))}</button>
      </div>
    </div>
  </div>`;
}

function openAddChapter() {
  if (!S.chapters.length && $("#add-text")) {
    $("#add-text").focus();
    return;
  }
  S.review = null;
  $("#modal-root").innerHTML = `<div class="pp-modal" data-act="modal-backdrop">
    <div class="pp-modal-card" role="dialog" aria-modal="true" aria-label="${esc(t("add.modalTitle"))}">
      <div class="pp-drawer-h"><span>${esc(t("add.modalTitle"))}</span><button class="pp-icon-btn sm" data-act="modal-close" aria-label="${esc(t("common.close"))}">${I.x}</button></div>
      ${addFormHTML(false)}
    </div></div>`;
  $("#add-text")?.focus();
}

function closeModal() {
  const wasReview = !!S.review;
  $("#modal-root").innerHTML = "";
  S.review = null;
  if (wasReview) {
    updateReviewCount();
    updateChapterStats();
  }
}

const addLang = () => $("#add-lang")?.value || S.lang;

function updateAddPreview() {
  const text = $("#add-text")?.value || "";
  const btn = $("#add-submit");
  const out = $("#add-preview");
  if (!btn || !out) return;
  if (!text.trim()) {
    btn.disabled = true;
    out.textContent = t("add.previewEmpty");
    return;
  }
  const lang = addLang();
  const paras = reflowText(text, $("#add-join")?.checked, lang);
  const st = buildStructure(paras, lang);
  const known = wordsOf(lang);
  let fresh = 0;
  for (const w of st.firstOcc.keys()) if (!known.has(w)) fresh++;
  btn.disabled = !paras.length;
  out.innerHTML = th("add.preview", { paras: paras.length, words: st.tokenCount, unique: st.firstOcc.size, fresh });
}

async function submitChapter() {
  const text = $("#add-text")?.value || "";
  const lang = addLang();
  const paragraphs = reflowText(text, $("#add-join")?.checked, lang);
  if (!paragraphs.length) return;
  const btn = $("#add-submit");
  btn.disabled = true;
  btn.textContent = t("common.saving");
  try {
    const heading = isChapterHeading(paragraphs[0]) ? paragraphs[0] : "";
    const sameLang = S.chapters.filter((c) => c.lang === lang).length;
    const title = (($("#add-title")?.value || "").trim() || heading || t("add.defaultTitle", { n: sameLang + 1 })).slice(0, 120);
    const position = S.chapters.reduce((m, c) => Math.max(m, c.position || 0), 0) + 1;
    const book = ($("#add-book")?.value || "").trim().slice(0, 120);
    const st = buildStructure(paragraphs, lang);
    const ch = await S.db.addChapter(title, paragraphs, position, lang, book, st.firstOcc.size);
    ch.lang = ch.lang || lang;
    const known = wordsOf(lang);
    const fresh = [...st.firstOcc.keys()].filter((w) => !known.has(w));
    await S.db.registerWords(fresh, ch.id, lang);
    for (const w of fresh) setRow({ ...blankRow(w, lang), first_chapter: ch.id });
    S.chapters.push(ch);
    S.chapterWords.set(ch.id, new Set(st.firstOcc.keys()));
    closeModal();
    goChapter(ch.id);
    toast(t("add.done", { unique: st.firstOcc.size, fresh: fresh.length }));
  } catch (e) {
    toast(t("add.failed", { msg: e.message }));
    btn.disabled = false;
    btn.textContent = t("add.submit");
  }
}

async function renameChapter(id) {
  const ch = S.chapters.find((c) => c.id === id);
  if (!ch) return;
  const title = prompt(t("chapters.renameAsk"), ch.title);
  if (!title || !title.trim()) return;
  try {
    await S.db.renameChapter(id, title.trim());
    ch.title = title.trim();
    if (S.chapter?.id === id) S.chapter.title = ch.title;
    updateChapterSelect();
    renderSettings();
    if (S.view === "home") renderHomeList();
  } catch (e) {
    toast(t("chapters.renameFailed", { msg: e.message }));
  }
}

async function deleteChapter(id) {
  const ch = S.chapters.find((c) => c.id === id);
  if (!ch || !confirm(t("chapters.confirmDelete", { title: ch.title }))) return;
  try {
    await S.db.deleteChapter(id);
    S.chapters = S.chapters.filter((c) => c.id !== id);
    S.chapterWords.delete(id);
    for (const r of wordsOf(ch.lang).values()) if (r.first_chapter === id) r.first_chapter = null;
    try {
      localStorage.removeItem(posKey(id));
    } catch {
      /* nothing to clean */
    }
    if (S.chapter?.id === id) {
      S.chapter = null;
      S.st = null;
    }
    if (S.settings.lastChapter === id) S.settings.lastChapter = null;
    updateChapterSelect();
    if (S.view === "read" && !S.chapter) goHome();
    else if (S.view === "home") renderHome();
    renderSettings();
    toast(t("chapters.deleted"));
  } catch (e) {
    toast(t("chapters.deleteFailed", { msg: e.message }));
  }
}

/* ---------------- Panel ---------------- */

const PANEL_TITLES = { word: "panel.word", vocab: "panel.vocab", progress: "panel.progress", settings: "panel.settings", admin: "panel.admin" };

function openPanel(mode) {
  S.panel = { open: true, mode };
  const d = $("#drawer");
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  $("#shell").classList.add("shift");
  $("#drawer-title").textContent = t(PANEL_TITLES[mode]);
  $$(".pp-actions [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderPanel();
  markSelection();
}

function closePanel(force = false) {
  if (!force && S.editing && !confirm(t("confirm.leaveEdit"))) return;
  S.editing = false;
  S.panel = { ...S.panel, open: false };
  const d = $("#drawer");
  d?.classList.remove("open");
  d?.setAttribute("aria-hidden", "true");
  $("#shell")?.classList.remove("shift");
  $$(".pp-actions [data-mode]").forEach((b) => b.classList.remove("on"));
  markSelection();
}

function togglePanel(mode) {
  if (S.panel.open && S.panel.mode === mode) closePanel();
  else {
    if (S.editing && !confirm(t("confirm.leaveEdit"))) return;
    S.editing = false;
    openPanel(mode);
  }
}

function renderPanel() {
  if (!S.panel.open) return;
  if (S.panel.mode === "word") renderWordView();
  else if (S.panel.mode === "vocab") renderVocab();
  else if (S.panel.mode === "progress") renderProgress();
  else if (S.panel.mode === "settings") renderSettings();
  else if (S.panel.mode === "admin") renderAdmin();
}

// Languages that have chapters or words: the vocabulary and progress panels can switch between them.
function knownLangs() {
  const set = new Set(chapterLangs());
  for (const [l, m] of S.vocab) if (m.size) set.add(l);
  set.add(S.lang);
  return [...set];
}
const panelLang = () => S.panelLang || S.lang;

function panelLangHTML() {
  const langs = knownLangs();
  if (langs.length < 2) return "";
  return `<label class="pp-label" for="panel-lang">${esc(t("panel.language"))}</label>
    <select class="pp-input pp-panel-lang" id="panel-lang">${langOptions(langs, panelLang(), false)}</select>`;
}

/* ---------------- Word ---------------- */

function onWordClick(el) {
  const sid = Number(el.dataset.s);
  const ti = Number(el.dataset.i);
  const inReader = !!el.closest(".pp-reader");
  selectWord(el.dataset.w, sid, ti);
  if (inReader && window.innerWidth <= MOBILE_MAX) keepVisible(el);
}

function selectWord(w, sid, ti) {
  if (S.editing && S.sel?.w !== w && !confirm(t("confirm.leaveEdit"))) return;
  const tok = S.st?.sentTokens[sid]?.[ti];
  if (!tok) return;
  const lang = S.chapter.lang;
  if (S.sel?.w !== w || S.sel?.lang !== lang) resetLibraryView();
  S.sel = { w, lang, sid, ti, surface: tok.t };
  S.editing = false;
  S.regenOpen = false;
  S.ctxErr = null;
  openPanel("word");
  ensureQuick(w, false, lang);
  ensureFull(w, lang).then(() => afterWordLoaded(w, lang));
  const row = rowOf(w, lang);
  if (S.settings.autoCard && apiKey() && !row.has_card && row.level > 1 && !S.gen.has(wkey(lang, w))) generateForSelected();
}

function openWordFromList(w, lang = S.lang) {
  const first = S.chapter?.lang === lang ? S.st?.occ.get(w)?.[0] : null;
  if (first) {
    selectWord(w, first[0], first[1]);
    requestAnimationFrame(() => scrollToToken(first[0], first[1]));
    return;
  }
  resetLibraryView();
  S.sel = { w, lang, sid: null, ti: null, surface: w };
  S.editing = false;
  S.regenOpen = false;
  openPanel("word");
  ensureQuick(w, false, lang);
  ensureFull(w, lang).then(() => afterWordLoaded(w, lang));
}

/* ----- Shared library ----- */

function resetLibraryView() {
  S.libOpen = false;
  S.libMore.clear();
}

// Once the word's own data is in: look for other learners' explanations if there is no card,
// and for a shared "why this word here" if this sentence has none.
function afterWordLoaded(w, lang) {
  if (!isSelected(w, lang)) return;
  const full = S.full.get(wkey(lang, w));
  if (!full?.card) loadLibrary(w, lang);
  if (S.sel.sid != null && S.st) {
    const sentence = S.st.sentences[S.sel.sid].trim();
    if (!(full?.contexts || []).some((c) => c.s === sentence && c.text)) ensureSharedCtx(w, lang, sentence);
  }
}

async function loadLibrary(w, lang, force = false) {
  const k = wkey(lang, w);
  if (!force && S.lib.has(k)) return;
  S.lib.set(k, "loading");
  try {
    S.lib.set(k, await S.db.sharedCardsFor(lang, w));
  } catch {
    S.lib.set(k, []);
  }
  if (isSelected(w, lang) && !S.editing) renderWordView();
}

async function ensureSharedCtx(w, lang, sentence) {
  const key = ctxKey(lang, xl(), sentence, w);
  if (S.sharedCtx.has(key)) return;
  S.sharedCtx.set(key, null);
  try {
    const found = await S.db.getSharedCtx(lang, xl(), sentence, w);
    S.sharedCtx.set(key, found);
    if (found && isSelected(w, lang) && !S.editing) renderWordView();
  } catch {
    /* the library is a bonus */
  }
}

const libItems = (w, lang) => {
  const v = S.lib.get(wkey(lang, w));
  return Array.isArray(v) ? v : [];
};

// Takes someone's explanation: the word's card becomes a pointer to it, not a copy.
async function useShared(id) {
  const sel = S.sel;
  if (!sel) return;
  const { w, lang } = sel;
  const k = wkey(lang, w);
  const item = libItems(w, lang).find((x) => x.id === id) || (await S.db.getSharedCard(id).catch(() => null));
  if (!item) return toast(t("lib.gone"));
  const c = item.card || {};
  const row = rowOf(w, lang);
  const quick =
    needsQuick(row) && c.translation
      ? { translation: c.translation, pronunciation: c.pronunciation || "", reading: c.reading || "", ipa: c.ipa || "", pos: c.pos || "", lemma: c.lemma || "", xl: item.xl }
      : row.quick;
  try {
    await S.db.saveWord({ word: w, lang, card: { ref: id, at: new Date().toISOString() }, quick });
    const full = S.full.get(k) || { word: w, lang, contexts: [], notes: null };
    const meta = { ref: id, by: item.by, byName: item.byName, likes: item.likes, model: item.model, xl: item.xl };
    S.full.set(k, { ...full, card: { ...c, meta }, refMissing: false, quick });
    setRow({ ...rowOf(w, lang), quick, has_card: true });
    S.libOpen = false;
    renderWordView();
    updateChapterStats();
    toast(t("lib.used"));
  } catch (e) {
    toast(t("edit.failed", { msg: e.message }));
  }
}

function bumpLikes(id, delta) {
  for (const v of S.lib.values()) if (Array.isArray(v)) for (const it of v) if (it.id === id) it.likes = Math.max(0, it.likes + delta);
  for (const f of S.full.values()) if (f?.card?.meta?.ref === id) f.card.meta.likes = Math.max(0, (f.card.meta.likes || 0) + delta);
  for (const it of S.admin?.shared || []) if (it.id === id) it.likes = Math.max(0, it.likes + delta);
}

async function toggleLike(id) {
  const on = !liked(id);
  const before = S.settings.liked || [];
  S.settings.liked = on ? [...before, id].slice(-LIKED_MAX) : before.filter((x) => x !== id);
  bumpLikes(id, on ? 1 : -1);
  renderPanel();
  try {
    await S.db.likeShared(id, on);
    saveSettingsSoon();
  } catch (e) {
    S.settings.liked = before;
    bumpLikes(id, on ? -1 : 1);
    renderPanel();
    toast(t("lib.likeFailed", { msg: e.message }));
  }
}

async function deleteShared(id) {
  if (!confirm(t("lib.confirmDelete"))) return;
  try {
    await S.db.deleteShared(id);
    for (const [key, v] of S.lib) if (Array.isArray(v)) S.lib.set(key, v.filter((it) => it.id !== id));
    if (S.admin?.shared) S.admin.shared = S.admin.shared.filter((it) => it.id !== id);
    renderPanel();
    toast(t("lib.deleted"));
  } catch (e) {
    toast(t("lib.deleteFailed", { msg: e.message }));
  }
}

// After an analysis made with the user's own key: add it to the shared library.
async function shareGenerated(w, lang, src, d, model, explainIn) {
  const k = wkey(lang, w);
  const me = S.db.userInfo().uid;
  const older = libItems(w, lang).filter((it) => it.by === me && it.xl === explainIn);
  const id = await S.db.shareCard({ lang, word: w, xl: explainIn, card: d, model });
  // A regenerated analysis replaces the author's previous one instead of piling up.
  for (const it of older) await S.db.deleteShared(it.id).catch(() => {});
  S.lib.delete(k); // reload the list next time the word opens
  await S.db.shareCtx({ lang, xl: explainIn, sentence: src.sentence, word: w, text: d.context, ru: d.sentence_translation, tr: d.translation });
  const quick = { translation: d.translation, pronunciation: d.pronunciation, reading: d.reading, ipa: d.ipa, pos: d.pos, lemma: d.lemma };
  await S.db.sharedDictAdd(lang, explainIn, [{ word: w, quick }]);
  return id;
}

function jumpOcc(dir) {
  if (!S.sel || S.sel.sid == null) return;
  const list = S.st.occ.get(S.sel.w) || [];
  if (list.length < 2) return;
  const i = list.findIndex(([s, tt]) => s === S.sel.sid && tt === S.sel.ti);
  const [sid, ti] = list[(i + dir + list.length) % list.length];
  selectWord(S.sel.w, sid, ti);
  scrollToToken(sid, ti);
}

function moveSelection(dir) {
  const list = S.st.tokenList;
  let i = list.findIndex(([s, tt]) => s === S.sel.sid && tt === S.sel.ti);
  for (let k = 0; k < list.length; k++) {
    i += dir;
    if (i < 0 || i >= list.length) return;
    const [s, tt] = list[i];
    const w = S.st.sentTokens[s][tt].w;
    if (S.settings.highlight !== "all" && rowOf(w, S.chapter.lang).level === 1) continue;
    selectWord(w, s, tt);
    scrollToToken(s, tt);
    return;
  }
}

async function setLevel(w, level, lang = selLang(), extra = {}) {
  const prev = rowOf(w, lang);
  if (prev.level === level && !extra.srs) return;
  const learned_at = level === 1 ? (prev.level === 1 && prev.learned_at) || new Date().toISOString() : null;
  setRow({ ...prev, level, learned_at, ...extra });
  afterLevelChange(w, lang);
  try {
    await S.db.saveWord({ word: w, lang, level, learned_at, ...extra });
  } catch (e) {
    setRow(prev);
    afterLevelChange(w, lang);
    toast(t("toast.levelNotSaved", { msg: e.message }));
  }
}

function afterLevelChange(w, lang) {
  refreshWordSpans(w, lang);
  updateChapterStats();
  updateVocabCount();
  updateReviewCount();
  if (S.sel?.w === w && S.sel.lang === lang) {
    const lvl = rowOf(w, lang).level;
    $$("#drawer-body .pp-level").forEach((b) => {
      const on = Number(b.dataset.level) === lvl;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
}

async function ensureQuick(w, force = false, lang = selLang()) {
  const k = wkey(lang, w);
  if (!needsQuick(rowOf(w, lang)) || S.quickBusy.has(k)) return;
  if (!force && S.quickErr.has(k)) return;
  let sentence = "";
  let surface = w;
  if (S.chapter?.lang === lang && S.st) {
    const sel = S.sel?.w === w && S.sel.lang === lang && S.sel.sid != null ? S.sel : null;
    const occ = S.st.firstOcc.get(w);
    const sid = sel ? sel.sid : occ?.sid;
    if (sid != null) sentence = S.st.sentences[sid].trim().slice(0, 200);
    surface = sel?.surface || occ?.surface || w;
  }
  S.quickBusy.add(k);
  S.quickErr.delete(k);
  patchQuick(w, lang);
  try {
    // The shared dictionary first: free for everyone. Then Claude, if the user has a key.
    const x = xl();
    let q = (await S.db.sharedDictLookup(lang, x, [w]).catch(() => new Map())).get(w);
    if (!q && apiKey()) {
      const res = await lookupWords({ apiKey: apiKey(), model: S.settings.dictModel, lang, xl: x, items: [{ word: surface, sentence }] });
      q = res.map.get(w) || [...res.map.values()][0];
      if (!q) throw new Error(t("err.noTranslation"));
      addSpent(res.cost);
      if (sharing()) S.db.sharedDictAdd(lang, x, [{ word: w, quick: q }]).catch(() => {});
    }
    if (q) {
      await S.db.saveWord({ word: w, lang, quick: q });
      applyQuick(w, lang, q);
    }
  } catch (e) {
    S.quickErr.set(k, e.message || String(e));
  } finally {
    S.quickBusy.delete(k);
    patchQuick(w, lang);
    updateChapterStats();
  }
}

function applyQuick(w, lang, q) {
  setRow({ ...rowOf(w, lang), quick: q });
  const f = S.full.get(wkey(lang, w));
  if (f) f.quick = q;
}

function patchQuick(w, lang) {
  if (S.review?.stage === "card" && S.review.revealed && S.review.queue[S.review.i] === w) renderReview();
  if (!isSelected(w, lang) || S.editing) return;
  const el = $("#wv-quick");
  if (el) el.innerHTML = quickHTML(w, rowOf(w, lang), lang);
}

async function ensureFull(w, lang = selLang()) {
  const k = wkey(lang, w);
  if (S.full.has(k)) return;
  if (!wordsOf(lang).has(w)) {
    S.full.set(k, { word: w, lang, card: null, contexts: [], notes: null });
    return;
  }
  try {
    const row = await S.db.getWordFull(w, lang);
    if (!S.full.has(k)) S.full.set(k, row || { word: w, lang, card: null, contexts: [], notes: null });
    if (isSelected(w, lang) && !S.editing) renderWordView();
  } catch (e) {
    toast(t("toast.cardNotLoaded", { msg: e.message }));
  }
}

function generateForSelected(wish = "") {
  const sel = S.sel;
  if (!sel) return;
  let src = null;
  if (sel.sid != null) {
    src = {
      sentence: S.st.sentences[sel.sid].trim(),
      context: contextAround(S.st.sentences, sel.sid, sel.lang),
      surface: sel.surface,
      chapterId: S.chapter.id,
    };
  } else {
    const c = S.full.get(wkey(sel.lang, sel.w))?.contexts?.[0];
    if (c) src = { sentence: c.s, context: c.s, surface: sel.w, chapterId: c.ch || null };
  }
  if (!src) return toast(t("toast.openChapterFirst"));
  S.regenOpen = false;
  generateFor(sel.w, sel.lang, src, wish);
}

function generateFor(w, lang, src, wish = "") {
  const key = apiKey();
  if (!key) {
    toast(t("toast.needKey"));
    openPanel("settings");
    return Promise.resolve(false);
  }
  const k = wkey(lang, w);
  if (S.gen.has(k)) return S.gen.get(k).promise;
  const job = { thinking: "", started: Date.now(), abort: new AbortController() };
  S.gen.set(k, job);
  S.genErr.delete(k);
  if (isSelected(w, lang) && !S.editing) renderWordView();
  const explainIn = xl();
  job.promise = (async () => {
    try {
      const res = await generateCard({
        apiKey: key,
        settings: S.settings,
        lang,
        xl: explainIn,
        surface: src.surface,
        sentence: src.sentence,
        context: src.context,
        wish,
        signal: job.abort.signal,
        onThinking: (text) => {
          job.thinking = text;
          patchThinking(w, lang);
        },
      });
      const d = res.data;
      let full = S.full.get(k);
      if (!full && wordsOf(lang).has(w)) full = await S.db.getWordFull(w, lang).catch(() => null);
      full = full || { word: w, lang, contexts: [], notes: null };
      const contexts = [
        ...(full.contexts || []).filter((c) => c.s !== src.sentence),
        { s: src.sentence, text: d.context, ru: d.sentence_translation, tr: d.translation, ch: src.chapterId, xl: explainIn },
      ].slice(-12);
      const card = {
        lemma: d.lemma,
        translation: d.translation,
        pos: d.pos,
        pronunciation: d.pronunciation,
        reading: d.reading,
        ipa: d.ipa,
        etymology: d.etymology,
        history: d.history,
        fact_type: d.fact_type,
        fact: d.fact,
        relatives: (d.relatives || []).slice(0, 6),
        mnemonic: d.mnemonic,
        meta: {
          model: res.model,
          effort: res.effort,
          xl: explainIn,
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cost: res.cost,
          at: new Date().toISOString(),
          ...(wish ? { wish } : {}),
        },
      };
      const row = rowOf(w, lang);
      const quick = needsQuick(row)
        ? { translation: d.translation, pronunciation: d.pronunciation, reading: d.reading, ipa: d.ipa, pos: d.pos, lemma: d.lemma, xl: explainIn }
        : row.quick;
      await S.db.saveWord({ word: w, lang, card, contexts, quick });
      S.full.set(k, { ...full, card, contexts, quick, refMissing: false });
      setRow({ ...rowOf(w, lang), quick, has_card: true });
      addSpent(res.cost);
      if (sharing()) shareGenerated(w, lang, src, d, res.model, explainIn).catch(() => {});
      return true;
    } catch (e) {
      if (e?.name !== "AbortError") S.genErr.set(k, e.message || String(e));
      return false;
    } finally {
      S.gen.delete(k);
      if (isSelected(w, lang) && !S.editing) renderWordView();
      updateChapterStats();
    }
  })();
  return job.promise;
}

function patchThinking(w, lang) {
  if (!isSelected(w, lang)) return;
  const el = $("#gen-thinking");
  const job = S.gen.get(wkey(lang, w));
  if (!el || !job) return;
  el.textContent = job.thinking.slice(-1800);
  el.scrollTop = el.scrollHeight;
}

async function explainHere() {
  const sel = S.sel;
  if (!sel || sel.sid == null) return;
  if (!apiKey()) {
    toast(t("toast.needKey"));
    return openPanel("settings");
  }
  const { w, lang } = sel;
  const k = wkey(lang, w);
  const sentence = S.st.sentences[sel.sid].trim();
  const base = S.full.get(k)?.card || rowOf(w, lang).quick || {};
  S.ctxJob = { w, lang, sid: sel.sid };
  S.ctxErr = null;
  renderWordView();
  try {
    const res = await explainContext({
      apiKey: apiKey(),
      settings: S.settings,
      lang,
      xl: xl(),
      surface: sel.surface,
      lemma: base.lemma,
      translation: base.translation,
      sentence,
      context: contextAround(S.st.sentences, sel.sid, lang),
    });
    const fresh = S.full.get(k) || { word: w, lang, contexts: [] };
    const contexts = [
      ...(fresh.contexts || []).filter((c) => c.s !== sentence),
      { s: sentence, text: res.data.context, ru: res.data.sentence_translation, tr: res.data.translation, ch: S.chapter.id, xl: xl() },
    ].slice(-12);
    await S.db.saveWord({ word: w, lang, contexts });
    S.full.set(k, { ...fresh, contexts });
    addSpent(res.cost);
    if (sharing()) {
      S.db.shareCtx({ lang, xl: xl(), sentence, word: w, text: res.data.context, ru: res.data.sentence_translation, tr: res.data.translation }).catch(() => {});
    }
  } catch (e) {
    S.ctxErr = e.message || String(e);
  } finally {
    S.ctxJob = null;
    if (isSelected(w, lang) && !S.editing) renderWordView();
  }
}

/* ----- Card HTML ----- */

function renderWordView() {
  const body = $("#drawer-body");
  if (!body || S.panel.mode !== "word") return;
  const sel = S.sel;
  if (!sel) {
    body.innerHTML = `<p class="pp-note pp-pad">${esc(t("word.pick"))}</p>`;
    return;
  }
  const { w, lang } = sel;
  const row = rowOf(w, lang);
  const full = S.full.get(wkey(lang, w));
  const keep = S.renderedWord === wkey(lang, w) ? body.scrollTop : 0;
  if (S.editing) {
    body.innerHTML = editHTML(sel, row, full);
  } else {
    const first = row.first_chapter ? chapterTitle(row.first_chapter) : "";
    body.innerHTML = `<div class="pp-wv">
      <div class="pp-headword" ${readerLangAttrs(lang)}><span>${esc(sel.surface)}</span><button class="pp-icon-btn sm" data-act="speak" data-text="${esc(sel.surface)}" data-lang="${esc(lang)}" title="${esc(t("word.say"))}" aria-label="${esc(t("word.say"))}">${I.volume}</button></div>
      <div id="wv-quick">${quickHTML(w, row, lang)}</div>
      ${levelsHTML(row)}
      ${dictLinksHTML(w, row, full, lang)}
      ${sentenceHTML(sel, row, full)}
      ${cardHTML(sel, row, full)}
      ${full?.notes ? `<section class="pp-sec"><h3 class="pp-h">${esc(t("word.notes"))}</h3><p class="pp-notes">${esc(full.notes)}</p></section>` : ""}
      ${first ? `<p class="pp-note pp-first">${esc(t("word.firstSeen", { title: first }))}</p>` : ""}
    </div>`;
  }
  body.scrollTop = keep;
  S.renderedWord = wkey(lang, w);
}

function quickChips(q, w, lang) {
  return [
    q.pronunciation && `<span class="pp-chip">[${esc(q.pronunciation)}]</span>`,
    q.reading && `<span class="pp-chip" lang="${esc(lang)}">${esc(q.reading)}</span>`,
    q.ipa && `<span class="pp-chip">/${esc(String(q.ipa).replace(/^\/|\/$/g, ""))}/</span>`,
    q.pos && `<span class="pp-chip">${esc(q.pos)}</span>`,
    q.lemma && wordKey(q.lemma, lang) !== w && `<span class="pp-chip">${esc(t("word.lemma"))} <b lang="${esc(lang)}">${esc(q.lemma)}</b></span>`,
  ]
    .filter(Boolean)
    .join("");
}

function quickHTML(w, row, lang) {
  const q = row.quick;
  const busy = S.quickBusy.has(wkey(lang, w));
  if (q && (q.translation || q.pronunciation) && !busy) {
    return `${q.translation ? `<div class="pp-tr">${esc(q.translation)}</div>` : ""}<div class="pp-chips">${quickChips(q, w, lang)}</div>`;
  }
  const err = S.quickErr.get(wkey(lang, w));
  if (err) return `<div class="pp-error"><p>${esc(t("word.quickFailed", { msg: err }))}</p><button class="pp-soft-btn" data-act="retry-quick">${esc(t("common.retry"))}</button></div>`;
  if (!busy && !apiKey())
    return `<p class="pp-note">${th("word.noKey", { settings: `<button class="pp-link" data-act="panel" data-mode="settings">${esc(t("empty.settingsLink"))}</button>` }, ["settings"])}</p>`;
  return `<div class="pp-sk" style="width:46%;height:20px"></div><div class="pp-sk" style="width:72%"></div>`;
}

function levelsHTML(row) {
  return `<div class="pp-levels" role="group" aria-label="${esc(t("level.groupLabel"))}">
    ${[5, 4, 3, 2, 1]
      .map(
        (l) =>
          `<button class="pp-level lv${l}${row.level === l ? " on" : ""}" data-act="level" data-level="${l}" aria-pressed="${row.level === l}"><b>${l}</b><span>${esc(t(`level.${l}`))}</span></button>`
      )
      .join("")}
  </div>
  <p class="pp-hint">${esc(t("level.hint"))}</p>`;
}

function dictLinksHTML(w, row, full, lang) {
  const lemma = row.quick?.lemma || full?.card?.lemma || w;
  return `<div class="pp-dicts" aria-label="${esc(t("word.dicts"))}">${dictLinks(lang, w, lemma, xl())
    .map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.label)} ${I.link}</a>`)
    .join("")}</div>`;
}

function sentenceHTML(sel, row, full) {
  const { w, lang } = sel;
  if (sel.sid == null) {
    const list = full?.contexts || [];
    if (!list.length) return "";
    return `<section class="pp-sec"><h3 class="pp-h">${esc(t("word.seenIn"))}</h3>${list
      .map(
        (c) =>
          `<div class="pp-ctx-item"><p class="pp-sent" ${readerLangAttrs(lang)}>${esc(c.s)}</p>${c.ru ? `<p class="pp-sent-ru">${esc(c.ru)}</p>` : ""}${c.text ? `<p>${esc(c.text)}</p>` : ""}</div>`
      )
      .join("")}</section>`;
  }
  const sentence = S.st.sentences[sel.sid].trim();
  const tokens = S.st.sentTokens[sel.sid];
  const occ = S.st.occ.get(w) || [];
  const pos = occ.findIndex(([s, tt]) => s === sel.sid && tt === sel.ti);
  const here = (full?.contexts || []).find((c) => c.s === sentence);
  const shared = here?.text ? null : S.sharedCtx.get(ctxKey(lang, xl(), sentence, w));
  const sentInner = tokens
    .map((tk, ti) =>
      tk.w
        ? `<span class="pp-wd l${rowOf(tk.w, lang).level}${tk.w === w ? (ti === sel.ti ? " is-cur" : " is-same") : ""}" data-w="${esc(tk.w)}" data-s="${sel.sid}" data-i="${ti}">${esc(tk.t)}</span>`
        : esc(tk.t)
    )
    .join("");
  let why;
  if (here?.text) {
    const qt = String(row.quick?.translation || "").toLowerCase();
    const showTr = here.tr && qt && !qt.includes(String(here.tr).toLowerCase());
    why = `<p>${esc(here.text)}${showTr ? ` <span class="pp-here-tr">${esc(t("word.hereTr", { tr: here.tr }))}</span>` : ""}</p>`;
  } else if (shared?.text) why = `<p>${esc(shared.text)}</p><p class="pp-note">${esc(t("lib.ctxShared"))}</p>`;
  else if (S.gen.has(wkey(lang, w))) why = `<p class="pp-note">${esc(t("word.whyWithCard"))}</p>`;
  else if (S.ctxJob?.w === w && S.ctxJob.lang === lang) why = skel(2);
  else if ((row.has_card || full?.card) && apiKey())
    why = `${S.ctxErr ? `<p class="pp-error-line">${esc(S.ctxErr)}</p>` : ""}<button class="pp-soft-btn" data-act="explain-here">${I.sparkles} ${esc(t("word.explainHere"))}</button>`;
  else why = `<p class="pp-note">${esc(t(apiKey() ? "word.whyAfterCard" : "word.whyNoKey"))}</p>`;

  return `<section class="pp-sec">
    <div class="pp-sec-h"><h3 class="pp-h">${esc(t("word.inStory"))}</h3>${
      occ.length > 1
        ? `<span class="pp-occ"><button data-act="occ" data-dir="-1" aria-label="${esc(t("word.prevOcc"))}">${I.left}</button>${esc(t("word.occOf", { i: pos + 1, n: occ.length }))}<button data-act="occ" data-dir="1" aria-label="${esc(t("word.nextOcc"))}">${I.right}</button></span>`
        : ""
    }</div>
    <div class="pp-sent-wrap">
      <p class="pp-sent hl-${esc(S.settings.highlight)}" data-hl ${readerLangAttrs(lang)}>${sentInner}</p>
      <button class="pp-icon-btn sm pp-sent-say" data-act="speak" data-text="${esc(sentence)}" data-lang="${esc(lang)}" title="${esc(t("word.readAloud"))}" aria-label="${esc(t("word.readAloud"))}">${I.volume}</button>
    </div>
    ${here?.ru || shared?.ru ? `<p class="pp-sent-ru">${esc(here?.ru || shared.ru)}</p>` : ""}
    <h3 class="pp-h pp-h-gap">${esc(t("word.why"))}</h3>
    ${why}
  </section>`;
}

function effortText(modelId, effort) {
  const info = modelInfo(modelId);
  return info.efforts && effort ? t("model.effortSuffix", { effort: t(`effort.${effort}`).toLowerCase() }) : "";
}

function cardHTML(sel, row, full) {
  const { w, lang } = sel;
  const k = wkey(lang, w);
  const job = S.gen.get(k);
  const card = full?.card;
  const info = modelInfo(S.settings.cardModel);
  const err = S.genErr.get(k);
  const key = !!apiKey();
  if (job) {
    const showThinking = S.settings.showThinking && info.thinking === "adaptive";
    return `<section class="pp-sec pp-gen">
      <div class="pp-gen-h"><span class="pp-spin">${I.loader}</span><span>${esc(t("gen.working", { model: info.name + effortText(info.id, S.settings.cardEffort) }))} <span id="gen-elapsed">${esc(t("gen.seconds", { n: Math.round((Date.now() - job.started) / 1000) }))}</span></span></div>
      ${showThinking ? `<div class="pp-thinking" id="gen-thinking" aria-live="polite">${esc(job.thinking.slice(-1800)) || esc(t("gen.thinkingPlaceholder"))}</div>` : ""}
      ${skel(4)}
      <button class="pp-soft-btn" data-act="gen-cancel">${esc(t("gen.cancel"))}</button>
    </section>`;
  }
  if (row.has_card && !full) return `<section class="pp-sec">${skel(5)}</section>`;
  const settingsLink = `<button class="pp-link" data-act="panel" data-mode="settings">${esc(t("empty.settingsLink"))}</button>`;
  if (!card) {
    const est = estimateCardCost(S.settings.cardModel, S.settings.cardEffort);
    const own = key
      ? `<button class="pp-primary" data-act="gen-card">${I.sparkles} ${esc(t("gen.button"))}</button>
         <p class="pp-note">${esc(info.name + effortText(info.id, S.settings.cardEffort))}.${info.custom ? "" : ` ${esc(t("gen.estimate", { cost: money(est) }))}`}</p>`
      : `<p class="pp-note">${th("gen.noKey", { settings: settingsLink }, ["settings"])}</p>`;
    const cta = `<section class="pp-sec pp-cta">
      ${full?.refMissing ? `<div class="pp-error"><p>${esc(t("lib.refMissing"))}</p></div>` : ""}
      ${err ? `<div class="pp-error"><p>${esc(t("gen.failed", { msg: err }))}</p></div>` : ""}
      ${own}
      <button class="pp-link" data-act="edit">${esc(t("gen.manual"))}</button>
    </section>`;
    // Without a key the library is the main way to get an explanation, so it goes first.
    return key ? cta + libraryHTML(sel) : libraryHTML(sel) + cta;
  }
  const fk = factKey(card.fact_type);
  const meta = card.meta || {};
  const fromLibrary = !!meta.ref;
  const metaLine = meta.manual
    ? t("card.manual")
    : fromLibrary
      ? meta.model
        ? t("lib.model", { model: modelInfo(meta.model).name })
        : ""
      : meta.model
        ? t("card.meta", {
            model: modelInfo(meta.model).name + effortText(meta.model, meta.effort),
            tokens: fmtInt((meta.input_tokens || 0) + (meta.output_tokens || 0)),
            cost: money(meta.cost || 0),
          })
        : "";
  const sec = (title, text) => (text ? `<section class="pp-sec"><h3 class="pp-h">${esc(title)}</h3><p>${esc(text)}</p></section>` : "");
  const qt = String(row.quick?.translation || "").toLowerCase();
  const otherXl = !meta.manual && cardXl(card) !== xl();
  const me = S.db.userInfo().uid;
  return `
    ${fromLibrary ? `<p class="pp-lib-src">${I.users}<span>${th("lib.fromBy", { name: meta.byName || t("lib.someone") })}</span>${likeButtonHTML(meta.ref, meta.likes, meta.by === me)}</p>` : ""}
    ${card.translation && qt && !qt.includes(String(card.translation).toLowerCase()) ? `<p class="pp-note pp-card-tr">${th("card.translatedAs", { tr: card.translation })}</p>` : ""}
    ${otherXl ? `<div class="pp-error pp-card-xl"><p>${esc(t("card.otherXl", { lang: langName(cardXl(card)) }))}</p>${key ? `<button class="pp-soft-btn" data-act="regen-xl">${I.sparkles} ${esc(t("card.regenXl", { lang: langName(xl()) }))}</button>` : ""}</div>` : ""}
    ${sec(t("card.etymology"), card.etymology)}
    ${sec(t("card.history"), card.history)}
    ${card.fact ? `<section class="pp-sec"><div class="pp-fact" data-k="${fk}"><div class="pp-fact-h"><span class="pp-fact-emoji" aria-hidden="true">${FACT_EMOJI[fk]}</span>${esc(t(`fact.${fk}.title`))}</div><p>${esc(card.fact)}</p></div></section>` : ""}
    ${card.relatives?.length ? `<section class="pp-sec"><h3 class="pp-h">${esc(t("card.relatives"))}</h3><div class="pp-chips">${card.relatives.map((r) => `<span class="pp-chip">${esc(r)}</span>`).join("")}</div></section>` : ""}
    ${card.mnemonic ? `<section class="pp-sec"><div class="pp-mn">${I.bulb}<div><h3 class="pp-h">${esc(t("card.mnemonic"))}</h3><p>${esc(card.mnemonic)}</p></div></div></section>` : ""}
    <section class="pp-sec pp-card-foot">
      ${err ? `<div class="pp-error"><p>${esc(t("gen.regenFailed", { msg: err }))}</p></div>` : ""}
      ${
        S.regenOpen && key
          ? `<label class="pp-label" for="regen-wish">${esc(t("regen.wishLabel"))}</label>
             <textarea class="pp-input" id="regen-wish" rows="2" placeholder="${esc(t("regen.wishPlaceholder"))}"></textarea>
             <div class="pp-row"><button class="pp-primary" data-act="regen-go">${I.sparkles} ${esc(t("regen.go"))}</button><button class="pp-soft-btn" data-act="regen-close">${esc(t("common.cancel"))}</button></div>
             <p class="pp-note">${esc(t("regen.note"))}</p>`
          : `<div class="pp-row">
               <button class="pp-soft-btn" data-act="edit">${I.edit} ${esc(t("card.edit"))}</button>
               ${key ? `<button class="pp-soft-btn" data-act="regen-open">${I.sparkles} ${esc(t("regen.go"))}</button>` : ""}
               ${S.libOpen ? "" : `<button class="pp-soft-btn" data-act="lib-open">${I.users} ${esc(t(fromLibrary ? "lib.chooseOther" : "lib.others"))}</button>`}
             </div>`
      }
      ${metaLine ? `<p class="pp-note">${esc(metaLine)}</p>` : ""}
      <p class="pp-note">${esc(t("card.aiNote"))}</p>
    </section>
    ${S.libOpen ? libraryHTML(sel) : ""}`;
}

function likeButtonHTML(id, likes, own) {
  const count = `<b>${fmtInt(likes || 0)}</b>`;
  if (own) return `<span class="pp-like is-own" title="${esc(t("lib.likesOwn"))}">${I.heart}${count}</span>`;
  const on = liked(id);
  return `<button class="pp-like${on ? " on" : ""}" data-act="lib-like" data-id="${esc(id)}" aria-pressed="${on}" title="${esc(t(on ? "lib.unlike" : "lib.like"))}">${I.heart}${count}</button>`;
}

// Other learners' explanations of the word, best first, the ones in your explanation language on top.
function libraryHTML(sel) {
  const { w, lang } = sel;
  const v = S.lib.get(wkey(lang, w));
  const head = (n) =>
    `<div class="pp-sec-h"><h3 class="pp-h">${esc(n == null ? t("lib.title") : t("lib.titleN", { n }))}</h3>${
      S.libOpen ? `<button class="pp-link" data-act="lib-close">${esc(t("lib.hide"))}</button>` : ""
    }</div>`;
  if (v === undefined || v === "loading") return `<section class="pp-sec pp-lib">${head(null)}${skel(2)}</section>`;
  if (!v.length) {
    if (apiKey() && !S.libOpen) return "";
    return `<section class="pp-sec pp-lib">${head(0)}<p class="pp-note">${esc(t(apiKey() ? "lib.emptyKey" : "lib.empty"))}</p></section>`;
  }
  const mine = xl();
  const items = [...v].sort((a, b) => (b.xl === mine) - (a.xl === mine));
  const current = S.full.get(wkey(lang, w))?.card?.meta?.ref;
  return `<section class="pp-sec pp-lib">${head(v.length)}${items.map((it) => libItemHTML(it, current)).join("")}</section>`;
}

function libItemHTML(it, current) {
  const me = S.db.userInfo().uid;
  const c = it.card || {};
  const open = S.libMore.has(it.id);
  const date = it.created ? new Date(it.created).toLocaleDateString(uiLang()) : "";
  const preview = c.etymology || c.history || c.fact || "";
  const part = (title, text) => (text ? `<h4 class="pp-lib-sub">${esc(title)}</h4><p>${esc(text)}</p>` : "");
  const body = open
    ? `${part(t("card.etymology"), c.etymology)}${part(t("card.history"), c.history)}${part(t(`fact.${factKey(c.fact_type)}.title`), c.fact)}${
        c.relatives?.length ? `<h4 class="pp-lib-sub">${esc(t("card.relatives"))}</h4><p>${esc(c.relatives.join(", "))}</p>` : ""
      }${part(t("card.mnemonic"), c.mnemonic)}`
    : `<p class="pp-lib-preview">${esc(preview.length > 180 ? `${preview.slice(0, 180)}…` : preview)}</p>`;
  return `<article class="pp-lib-item${it.id === current ? " is-used" : ""}">
    <div class="pp-lib-h">
      <span class="pp-lib-by">${esc(it.byName || t("lib.someone"))}</span>
      ${it.xl !== xl() ? `<span class="pp-lang-tag" title="${esc(langName(it.xl))}">${esc(langCode(it.xl))}</span>` : ""}
      <span class="pp-note">${esc(date)}</span>
      ${likeButtonHTML(it.id, it.likes, it.by === me)}
    </div>
    ${c.translation ? `<p class="pp-lib-tr">${esc(c.translation)}</p>` : ""}
    <div class="pp-lib-body">${body}</div>
    <div class="pp-row pp-lib-actions">
      ${
        it.id === current
          ? `<span class="pp-note">${esc(t("lib.inUse"))}</span>`
          : `<button class="pp-soft-btn" data-act="lib-use" data-id="${esc(it.id)}">${esc(t("lib.use"))}</button>`
      }
      <button class="pp-link" data-act="lib-more" data-id="${esc(it.id)}">${esc(t(open ? "lib.less" : "lib.more"))}</button>
      ${it.by === me || S.isAdmin ? `<button class="pp-link pp-danger" data-act="lib-delete" data-id="${esc(it.id)}">${esc(t("lib.delete"))}</button>` : ""}
    </div>
  </article>`;
}

function editHTML(sel, row, full) {
  const { lang } = sel;
  const q = row.quick || {};
  const c = full?.card || {};
  const attached = sel.sid != null;
  const sentence = attached ? S.st.sentences[sel.sid].trim() : "";
  const here = attached ? (full?.contexts || []).find((x) => x.s === sentence) || {} : null;
  const field = (id, label, value, rows = 0, extra = "") =>
    `<label class="pp-label" for="${id}">${esc(label)}</label>${
      rows
        ? `<textarea class="pp-input" id="${id}" rows="${rows}" ${extra}>${esc(value || "")}</textarea>`
        : `<input class="pp-input" id="${id}" value="${esc(value || "")}" ${extra}>`
    }`;
  const showReading = !!langInfo(lang).reading || !!q.reading;
  return `<div class="pp-wv pp-edit">
    <div class="pp-headword" ${readerLangAttrs(lang)}><span>${esc(sel.surface)}</span></div>
    <p class="pp-note">${esc(t("edit.lead"))}</p>
    <fieldset class="pp-fieldset"><legend>${esc(t("edit.dict"))}</legend>
      ${field("e-q-translation", t("edit.translation"), q.translation)}
      ${field("e-q-pronunciation", t("edit.pronunciation"), q.pronunciation)}
      ${showReading ? field("e-q-reading", t("edit.reading"), q.reading, 0, `lang="${esc(lang)}"`) : ""}
      ${field("e-q-ipa", t("edit.ipa"), q.ipa)}
      ${field("e-q-pos", t("edit.pos"), q.pos)}
      ${field("e-q-lemma", t("edit.lemma"), q.lemma, 0, `lang="${esc(lang)}"`)}
    </fieldset>
    ${
      attached
        ? `<fieldset class="pp-fieldset"><legend>${esc(t("word.inStory"))}</legend>
      <p class="pp-sent" ${readerLangAttrs(lang)}>${esc(sentence)}</p>
      ${field("e-h-ru", t("edit.sentenceTr"), here.ru, 2)}
      ${field("e-h-tr", t("edit.hereTr"), here.tr)}
      ${field("e-h-text", t("word.why"), here.text, 3)}
    </fieldset>`
        : ""
    }
    <fieldset class="pp-fieldset"><legend>${esc(t("edit.card"))}</legend>
      ${field("e-c-translation", t("edit.cardTr"), c.translation)}
      ${field("e-c-etymology", t("card.etymology"), c.etymology, 3)}
      ${field("e-c-history", t("card.history"), c.history, 4)}
      <label class="pp-label" for="e-c-fact_type">${esc(t("edit.factType"))}</label>
      <select class="pp-input" id="e-c-fact_type">${FACT_TYPES.map(
        (ft) => `<option value="${ft}"${factKey(c.fact_type) === ft ? " selected" : ""}>${esc(t(`fact.${ft}`))}</option>`
      ).join("")}</select>
      ${field("e-c-fact", t("edit.fact"), c.fact, 3)}
      ${field("e-c-relatives", t("edit.relatives"), (c.relatives || []).join("\n"), 3)}
      ${field("e-c-mnemonic", t("card.mnemonic"), c.mnemonic, 2)}
    </fieldset>
    <fieldset class="pp-fieldset"><legend>${esc(t("word.notes"))}</legend>
      ${field("e-notes", t("edit.notes"), full?.notes, 3)}
    </fieldset>
    <div class="pp-row pp-edit-actions"><button class="pp-primary" data-act="edit-save">${esc(t("common.save"))}</button><button class="pp-soft-btn" data-act="edit-cancel">${esc(t("common.cancel"))}</button></div>
  </div>`;
}

async function saveEdit() {
  const sel = S.sel;
  if (!sel) return;
  const { w, lang } = sel;
  const k = wkey(lang, w);
  const row = rowOf(w, lang);
  const full = S.full.get(k) || { word: w, lang, contexts: [], card: null, notes: null };
  const v = (id) => ($(`#${id}`)?.value ?? "").trim();

  const quickRaw = {
    translation: v("e-q-translation"),
    pronunciation: v("e-q-pronunciation"),
    reading: v("e-q-reading"),
    ipa: v("e-q-ipa"),
    pos: v("e-q-pos"),
    lemma: v("e-q-lemma"),
  };
  const changed = Object.keys(quickRaw).some((f) => quickRaw[f] !== String(row.quick?.[f] || ""));
  let quick = Object.values(quickRaw).some(Boolean) ? { ...quickRaw, xl: quickXl(row.quick) } : null;
  // Hand-made changes are kept even if the explanation language changes later.
  if (quick && (changed || row.quick?.manual)) quick = { ...quick, xl: xl(), manual: true };

  const fields = {
    translation: v("e-c-translation"),
    etymology: v("e-c-etymology"),
    history: v("e-c-history"),
    fact_type: v("e-c-fact_type"),
    fact: v("e-c-fact"),
    relatives: v("e-c-relatives").split("\n").map((s) => s.trim()).filter(Boolean),
    mnemonic: v("e-c-mnemonic"),
  };
  const hasText = ["translation", "etymology", "history", "fact", "mnemonic"].some((f) => fields[f]) || fields.relatives.length > 0;
  const shared = { lemma: quickRaw.lemma, pos: quickRaw.pos, pronunciation: quickRaw.pronunciation, reading: quickRaw.reading, ipa: quickRaw.ipa };
  let card = null;
  if (hasText) {
    card = full.card
      ? { ...full.card, ...shared, ...fields }
      : { ...shared, ...fields, meta: { manual: true, xl: xl(), at: new Date().toISOString() } };
    // Editing an explanation taken from the library makes it your own copy; the shared one stays as it was.
    if (card.meta?.ref) card.meta = { manual: true, forkOf: card.meta.ref, xl: card.meta.xl, at: new Date().toISOString() };
  }

  let contexts = full.contexts || [];
  if (sel.sid != null && $("#e-h-text")) {
    const sentence = S.st.sentences[sel.sid].trim();
    const prev = contexts.find((c) => c.s === sentence) || { s: sentence, ch: S.chapter?.id || null };
    const entry = { ...prev, text: v("e-h-text"), ru: v("e-h-ru"), tr: v("e-h-tr") };
    contexts = [...contexts.filter((c) => c.s !== sentence), ...(entry.text || entry.ru || entry.tr ? [entry] : [])];
  }
  const notes = v("e-notes") || null;

  const btn = $('[data-act="edit-save"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = t("common.saving");
  }
  try {
    await S.db.saveWord({ word: w, lang, quick, card, contexts, notes });
    S.full.set(k, { ...full, quick, card, contexts, notes });
    setRow({ ...row, quick, has_card: !!card });
    S.editing = false;
    renderWordView();
    updateChapterStats();
    toast(t("edit.saved"));
  } catch (e) {
    toast(t("edit.failed", { msg: e.message }));
    if (btn) {
      btn.disabled = false;
      btn.textContent = t("common.save");
    }
  }
}

/* ---------------- Chapter dictionary and bulk analysis ---------------- */

async function prepareDictionary(manual = false) {
  if (!S.st || !S.chapter) return;
  if (S.dict.running) return;
  const lang = S.chapter.lang;
  const x = xl();
  let missing = [...S.st.firstOcc.entries()]
    .filter(([w]) => needsQuick(rowOf(w, lang)))
    .map(([w, o]) => ({ key: w, word: o.surface, sentence: S.st.sentences[o.sid].trim().slice(0, 160) }));
  if (!missing.length) {
    if (manual) toast(t("dict.ready"));
    return;
  }
  const token = {};
  S.dict = { running: true, done: 0, total: missing.length, token };
  updateTopProgress();
  updateChapterStats();
  const touchSelected = (rows) => {
    if (S.sel && S.sel.lang === lang && rows.some((r) => r.word === S.sel.w)) patchQuick(S.sel.w, lang);
  };

  // 1. The shared dictionary: free for everyone, with or without a key.
  try {
    const found = await S.db.sharedDictLookup(lang, x, missing.map((m) => m.key));
    if (found.size) {
      const rows = [...found].map(([word, quick]) => ({ word, lang, quick }));
      await S.db.saveWords(rows);
      for (const r of rows) applyQuick(r.word, lang, r.quick);
      touchSelected(rows);
      missing = missing.filter((m) => !found.has(m.key));
      if (S.dict.token === token) {
        S.dict.done = found.size;
        updateTopProgress();
      }
    }
  } catch {
    /* the library is a bonus: carry on with Claude */
  }

  // 2. Claude, for words nobody has translated yet. Saved every few batches to spare database writes.
  let failed = null;
  if (missing.length && apiKey()) {
    let pending = [];
    let batches = 0;
    const flush = async () => {
      if (!pending.length) return;
      const rows = pending;
      pending = [];
      await S.db.saveWords(rows);
      if (sharing()) S.db.sharedDictAdd(lang, x, rows.map((r) => ({ word: r.word, quick: r.quick }))).catch(() => {});
    };
    const base = S.dict.done;
    for (let i = 0; i < missing.length; i += DICT_BATCH) {
      if (S.dict.token !== token) break;
      const batch = missing.slice(i, i + DICT_BATCH).filter((it) => needsQuick(rowOf(it.key, lang)));
      if (batch.length) {
        try {
          const res = await lookupWords({
            apiKey: apiKey(),
            model: S.settings.dictModel,
            lang,
            xl: x,
            items: batch.map(({ word, sentence }) => ({ word, sentence })),
          });
          const rows = batch.filter((it) => res.map.has(it.key)).map((it) => ({ word: it.key, lang, quick: res.map.get(it.key) }));
          for (const r of rows) applyQuick(r.word, lang, r.quick);
          touchSelected(rows);
          pending.push(...rows);
          addSpent(res.cost);
          if (++batches % DICT_FLUSH === 0) await flush();
        } catch (e) {
          failed = e;
          break;
        }
      }
      if (S.dict.token === token) {
        S.dict.done = Math.min(S.dict.total, base + i + DICT_BATCH);
        updateTopProgress();
      }
    }
    // Paid translations are saved even when the user stopped the run.
    try {
      await flush();
    } catch (e) {
      failed = failed || e;
    }
  }
  if (S.dict.token !== token) return;
  S.dict = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  if (failed) toast(t("dict.stoppedError", { msg: failed.message }));
  else if (manual && missing.length && !apiKey()) toast(t("dict.needKeyForRest", { n: missing.length }));
}

function stopDictionary(silent = false) {
  if (!S.dict.running) return;
  S.dict = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  if (!silent) toast(t("dict.stopped"));
}

async function bulkAnalyze() {
  if (!S.st) return;
  if (!apiKey()) {
    toast(t("toast.needKey"));
    return openPanel("settings");
  }
  const lang = S.chapter.lang;
  const todo = [...S.st.firstOcc.entries()].filter(([w]) => rowOf(w, lang).level > 1 && !rowOf(w, lang).has_card);
  if (!todo.length) return toast(t("bulk.nothing"));
  const info = modelInfo(S.settings.cardModel);
  const est = estimateCardCost(S.settings.cardModel, S.settings.cardEffort) * todo.length;
  const ok = confirm(
    `${t("bulk.confirm", { n: todo.length, model: info.name + effortText(info.id, S.settings.cardEffort) })}\n` +
      (info.custom ? "" : `${t("bulk.estimate", { cost: money(est) })}\n`) +
      t("bulk.confirmNote")
  );
  if (!ok) return;
  const token = {};
  S.bulk = { running: true, done: 0, total: todo.length, token };
  updateTopProgress();
  updateChapterStats();
  const queue = [...todo];
  const chapterId = S.chapter.id;
  const st = S.st;
  let failures = 0;
  let lastError = "";
  const worker = async () => {
    while (queue.length && S.bulk.token === token) {
      const [w, o] = queue.shift();
      if (!rowOf(w, lang).has_card && rowOf(w, lang).level > 1) {
        const done = await generateFor(w, lang, {
          sentence: st.sentences[o.sid].trim(),
          context: contextAround(st.sentences, o.sid, lang),
          surface: o.surface,
          chapterId,
        });
        if (!done) {
          failures++;
          lastError = S.genErr.get(wkey(lang, w)) || lastError;
          if (failures >= 3 && S.bulk.token === token) {
            S.bulk = { running: false, done: 0, total: 0, token: null };
            toast(t("bulk.stoppedErrors", { msg: lastError }), 7000);
          }
        }
      }
      if (S.bulk.token === token) {
        S.bulk.done++;
        updateTopProgress();
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (S.bulk.token === token) {
    S.bulk = { running: false, done: 0, total: 0, token: null };
    toast(failures ? t("bulk.doneErrors", { n: failures }) : t("bulk.done"));
  }
  updateTopProgress();
  updateChapterStats();
}

function stopBulk() {
  S.bulk = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  toast(t("bulk.stopped"));
}

/* ---------------- Review ---------------- */

function dueCount(lang = S.lang) {
  const now = Date.now();
  let n = 0;
  for (const r of wordsOf(lang).values()) if (r.srs?.due && Date.parse(r.srs.due) <= now) n++;
  return n;
}

function updateReviewCount() {
  const el = $("#review-count");
  if (!el) return;
  const n = dueCount();
  el.hidden = n === 0;
  el.textContent = n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
}

const chapterScopeAvailable = (lang) => S.chapter?.lang === lang && !!S.st;

// Due words first, then new ones: words you rated 4–2 come before untouched words.
function reviewPools(lang, scope) {
  const now = Date.now();
  const only = scope === "chapter" && chapterScopeAvailable(lang) ? S.chapterWords.get(S.chapter.id) : null;
  const due = [];
  const fresh = [];
  for (const r of wordsOf(lang).values()) {
    if (only && !only.has(r.word)) continue;
    if (r.srs?.due) {
      if (Date.parse(r.srs.due) <= now) due.push(r);
    } else if (r.level > 1 && r.quick?.translation) fresh.push(r);
  }
  due.sort((a, b) => Date.parse(a.srs.due) - Date.parse(b.srs.due));
  const rank = (r) => (r.level < 5 ? 0 : r.has_card ? 1 : 2);
  const order = only ? new Map([...S.st.firstOcc.keys()].map((w, i) => [w, i])) : null;
  const rnd = new Map(fresh.map((r) => [r.word, Math.random()]));
  fresh.sort((a, b) => rank(a) - rank(b) || (order ? order.get(a.word) - order.get(b.word) : rnd.get(a.word) - rnd.get(b.word)));
  return { due, fresh };
}

function openReview() {
  if (S.editing && !confirm(t("confirm.leaveEdit"))) return;
  if (S.editing) {
    S.editing = false;
    renderPanel();
  }
  const scope = chapterScopeAvailable(S.lang) ? "chapter" : "all";
  S.review = { stage: "start", scope, lang: S.lang };
  renderReview();
}

function startReview() {
  const rv = S.review;
  const { due, fresh } = reviewPools(rv.lang, rv.scope);
  const queue = [...due.slice(0, REVIEW_MAX_DUE), ...fresh.slice(0, S.settings.reviewNew)].map((r) => r.word);
  if (!queue.length) return;
  Object.assign(rv, { stage: "card", queue, i: 0, revealed: false, again: new Map(), seen: 0, known: 0 });
  renderReview();
}

function revealReview() {
  const rv = S.review;
  if (!rv || rv.stage !== "card" || rv.revealed) return;
  rv.revealed = true;
  renderReview();
}

function rateReview(level) {
  const rv = S.review;
  if (!rv || rv.stage !== "card" || !rv.revealed) return;
  const w = rv.queue[rv.i];
  setLevel(w, level, rv.lang, { srs: schedule(rowOf(w, rv.lang).srs, level) });
  rv.seen++;
  if (level <= 2) rv.known++;
  // "Don't know" comes back a few cards later, at most twice per session.
  if (level === 5) {
    const n = rv.again.get(w) || 0;
    if (n < 2) {
      rv.again.set(w, n + 1);
      rv.queue.splice(Math.min(rv.queue.length, rv.i + 5), 0, w);
    }
  }
  rv.i++;
  rv.revealed = false;
  if (rv.i >= rv.queue.length) rv.stage = "done";
  renderReview();
}

// The sentence to show with a card: from the open chapter, or from a saved explanation.
function reviewContext(w, lang, full) {
  if (chapterScopeAvailable(lang)) {
    const first = S.st.occ.get(w)?.[0];
    if (first) {
      const [sid, ti] = first;
      const tokens = S.st.sentTokens[sid];
      const html = tokens.map((tk, i) => (tk.w && i === ti ? `<mark class="pp-rv-mark">${esc(tk.t)}</mark>` : esc(tk.t))).join("");
      const sentence = S.st.sentences[sid].trim();
      const ru = (full?.contexts || []).find((c) => c.s === sentence)?.ru || "";
      return { html, ru, surface: tokens[ti].t };
    }
  }
  const c = (full?.contexts || [])[0];
  if (!c?.s) return null;
  const tokens = tokenize(c.s, lang);
  const hit = tokens.find((tk) => tk.w === w);
  const html = tokens.map((tk) => (tk.w === w ? `<mark class="pp-rv-mark">${esc(tk.t)}</mark>` : esc(tk.t))).join("");
  return { html, ru: c.ru || "", surface: hit?.t || w };
}

function reviewStartHTML(rv) {
  const lname = langName(rv.lang);
  const chapterOk = chapterScopeAvailable(rv.lang);
  if (!chapterOk) rv.scope = "all";
  const { due, fresh } = reviewPools(rv.lang, rv.scope);
  const nDue = Math.min(due.length, REVIEW_MAX_DUE);
  const nNew = Math.min(fresh.length, S.settings.reviewNew);
  const total = nDue + nNew;
  const scopeBtn = (val, label) =>
    `<button role="radio" aria-checked="${rv.scope === val}" class="${rv.scope === val ? "on" : ""}" data-act="rv-scope" data-val="${val}">${esc(label)}</button>`;
  return `<div class="pp-rv-start">
    ${chapterOk ? `<div class="pp-seg" role="radiogroup" aria-label="${esc(t("rv.scope"))}">${scopeBtn("chapter", t("rv.scopeChapter"))}${scopeBtn("all", t("rv.scopeAll", { lang: lname }))}</div>` : ""}
    <div class="pp-rv-stats">
      <div><b>${fmtInt(nDue)}</b><span>${esc(t("rv.due"))}</span></div>
      <div><b>${fmtInt(nNew)}</b><span>${esc(t("rv.new"))}</span></div>
    </div>
    ${
      total
        ? `<button class="pp-primary" data-act="rv-start">${I.cards} ${esc(t("rv.start", { n: total }))}</button>`
        : `<p class="pp-lead">${esc(t("rv.nothing"))}</p>`
    }
    ${fresh.length > nNew ? `<p class="pp-note">${esc(t("rv.moreNew", { n: fresh.length - nNew }))}</p>` : ""}
    <p class="pp-note">${esc(t("rv.how"))}</p>
  </div>`;
}

function reviewCardHTML(rv) {
  const w = rv.queue[rv.i];
  const lang = rv.lang;
  const row = rowOf(w, lang);
  const full = S.full.get(wkey(lang, w));
  const ctx = reviewContext(w, lang, full);
  const surface = ctx?.surface || w;
  const q = row.quick || {};
  let html = `<div class="pp-rv-card">
    <div class="pp-rv-word" ${readerLangAttrs(lang)}><span>${esc(surface)}</span><button class="pp-icon-btn sm" data-act="speak" data-text="${esc(surface)}" data-lang="${esc(lang)}" title="${esc(t("word.say"))}" aria-label="${esc(t("word.say"))}">${I.volume}</button></div>
    ${ctx ? `<p class="pp-sent pp-rv-sent" ${readerLangAttrs(lang)}>${ctx.html}</p>` : ""}`;
  if (!rv.revealed) {
    html += `<button class="pp-primary pp-rv-show" data-act="rv-show">${esc(t("rv.show"))}</button>
      <p class="pp-hint">${esc(t("rv.showHint"))}</p>`;
  } else {
    html += `<div class="pp-rv-answer">
      ${q.translation ? `<div class="pp-tr">${esc(q.translation)}</div>` : ""}
      <div class="pp-chips">${quickChips(q, w, lang)}</div>
      ${ctx?.ru ? `<p class="pp-sent-ru">${esc(ctx.ru)}</p>` : ""}
      ${full?.card?.mnemonic ? `<div class="pp-mn">${I.bulb}<p>${esc(full.card.mnemonic)}</p></div>` : ""}
    </div>
    <div class="pp-levels pp-rv-levels" role="group" aria-label="${esc(t("rv.rateLabel"))}">${[5, 4, 3, 2, 1]
      .map(
        (l) =>
          `<button class="pp-level lv${l}" data-act="rv-rate" data-level="${l}"><b>${l}</b><span>${esc(t(`level.${l}`))}</span><i>${esc(ivlLabel(schedule(row.srs, l).ivl))}</i></button>`
      )
      .join("")}</div>
    <p class="pp-hint">${esc(t("rv.rateHint"))}</p>`;
  }
  return `${html}</div>`;
}

function reviewDoneHTML(rv) {
  return `<div class="pp-rv-start">
    <h2 class="pp-rv-done">${esc(t("rv.doneTitle"))}</h2>
    <p class="pp-lead">${esc(t("rv.doneText", { n: rv.seen, known: rv.known }))}</p>
    <div class="pp-row"><button class="pp-primary" data-act="rv-close">${esc(t("rv.finish"))}</button><button class="pp-soft-btn" data-act="rv-again">${esc(t("rv.more"))}</button></div>
  </div>`;
}

function renderReview() {
  const rv = S.review;
  const root = $("#modal-root");
  if (!rv || !root) return;
  let body;
  let progress = "";
  if (rv.stage === "start") body = reviewStartHTML(rv);
  else if (rv.stage === "card") {
    body = reviewCardHTML(rv);
    progress = `<span class="pp-rv-count">${esc(t("rv.progress", { i: rv.i + 1, n: rv.queue.length }))}</span>`;
  } else body = reviewDoneHTML(rv);
  const bar = rv.stage === "card" ? `<div class="pp-rv-bar"><i style="width:${(rv.i / rv.queue.length) * 100}%"></i></div>` : "";
  root.innerHTML = `<div class="pp-modal">
    <div class="pp-modal-card pp-rv" role="dialog" aria-modal="true" aria-label="${esc(t("rv.title", { lang: langName(rv.lang) }))}">
      <div class="pp-drawer-h"><span>${esc(t("rv.title", { lang: langName(rv.lang) }))}</span>${progress}<button class="pp-icon-btn sm" data-act="rv-close" aria-label="${esc(t("common.close"))}">${I.x}</button></div>
      ${bar}${body}
    </div></div>`;
  if (rv.stage === "card") {
    const w = rv.queue[rv.i];
    if (!S.full.has(wkey(rv.lang, w))) {
      ensureFull(w, rv.lang).then(() => {
        if (S.review === rv && rv.stage === "card" && rv.queue[rv.i] === w) renderReview();
      });
    }
    if (!rowOf(w, rv.lang).quick && apiKey()) ensureQuick(w, false, rv.lang);
  }
}

/* ---------------- My vocabulary ---------------- */

function renderVocab() {
  const body = $("#drawer-body");
  body.innerHTML = `<div class="pp-vocab">
    ${panelLangHTML()}
    <label class="pp-search"><input data-role="vocab-search" value="${esc(S.vfilter.q)}" placeholder="${esc(t("vocab.search"))}" aria-label="${esc(t("vocab.search"))}"></label>
    <div class="pp-filter" role="group" aria-label="${esc(t("vocab.filter"))}">
      ${[[0, t("vocab.allLevels")], [5, "5"], [4, "4"], [3, "3"], [2, "2"], [1, "1"]]
        .map(([l, label]) => `<button class="pp-chip-btn lv${l}${S.vfilter.level === l ? " on" : ""}" data-act="vocab-level" data-level="${l}">${esc(label)}</button>`)
        .join("")}
    </div>
    <div id="vocab-list"></div>
  </div>`;
  renderVocabList();
}

function renderVocabList() {
  const box = $("#vocab-list");
  if (!box) return;
  const lang = panelLang();
  const words = wordsOf(lang);
  const q = searchKey(S.vfilter.q.trim());
  let rows = [...words.values()];
  if (S.vfilter.level) rows = rows.filter((r) => r.level === S.vfilter.level);
  if (q) rows = rows.filter((r) => searchKey(r.word).includes(q) || searchKey(r.quick?.translation).includes(q));
  rows.sort((a, b) => a.word.localeCompare(b.word, lang));
  box.innerHTML = `<p class="pp-note">${esc(rows.length ? t("vocab.count", { n: rows.length }) : words.size ? t("vocab.notFound") : t("vocab.empty"))}</p>
    <ul class="pp-vlist">${rows
      .slice(0, 600)
      .map(
        (r) =>
          `<li><button data-act="open-word" data-w="${esc(r.word)}" data-lang="${esc(lang)}"><span class="pp-dot lv${r.level}" title="${esc(t("level.title", { l: r.level }))}"></span><span class="pp-v-word" ${readerLangAttrs(lang)}>${esc(r.word)}</span><span class="pp-v-tr">${esc(r.quick?.translation || "")}</span></button></li>`
      )
      .join("")}</ul>
    ${rows.length > 600 ? `<p class="pp-note">${esc(t("vocab.first600"))}</p>` : ""}`;
}

/* ---------------- Progress ---------------- */

function renderProgress() {
  const body = $("#drawer-body");
  const lang = panelLang();
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let cards = 0;
  let week = 0;
  let reviewed = 0;
  const weekAgo = Date.now() - 7 * 864e5;
  for (const r of wordsOf(lang).values()) {
    c[r.level]++;
    if (r.has_card) cards++;
    if (r.level === 1 && r.learned_at && Date.parse(r.learned_at) > weekAgo) week++;
    if (r.srs) reviewed++;
  }
  const total = wordsOf(lang).size;
  body.innerHTML = `
    <section class="pp-sec pp-sec-first">
      ${panelLangHTML()}
      <h3 class="pp-h pp-mt">${esc(t("prog.allWords", { lang: langName(lang) }))}</h3>
      <p class="pp-big">${th("prog.learned", { learned: c[1], total })}</p>
      ${[5, 4, 3, 2, 1]
        .map(
          (l) => `<div class="pp-prog-row"><span class="pp-dot lv${l}"></span><span class="pp-prog-label">${l}, ${esc(t(`level.${l}`))}</span>
          <span class="pp-prog-bar"><i class="lb${l}" style="width:${total ? (c[l] / total) * 100 : 0}%"></i></span><b>${fmtInt(c[l])}</b></div>`
        )
        .join("")}
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("prog.work"))}</h3>
      <p>${th("prog.week", { n: week })}</p>
      <p>${th("prog.cards", { n: cards })}</p>
      <p>${th("prog.review", { n: reviewed, due: dueCount(lang) })}</p>
      <p>${th("prog.spent", { cost: money(S.settings.spent || 0) })} <button class="pp-link" data-act="reset-spent">${esc(t("prog.reset"))}</button></p>
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("prog.chapters"))}</h3>
      <div id="prog-chapters">${chaptersProgressHTML(lang)}</div>
    </section>`;
  loadChapterWords(lang);
}

function chaptersProgressHTML(lang) {
  const list = S.chapters.filter((ch) => ch.lang === lang);
  if (!list.length) return `<p class="pp-note">${esc(t("prog.noChapters"))}</p>`;
  return list
    .map((ch) => {
      const set = S.chapterWords.get(ch.id);
      if (!set) return `<div class="pp-prog-ch"><span>${esc(ch.title)}</span><span class="pp-note">${esc(t("prog.counting"))}</span></div>`;
      const c = levelCounts(set, lang);
      const pct = set.size ? Math.round((c[1] / set.size) * 100) : 0;
      return `<div class="pp-prog-ch"><div class="pp-prog-ch-h"><span>${esc(ch.title)}</span><b>${pct}%</b></div><div class="pp-levelbar">${levelBarHTML(c)}</div></div>`;
    })
    .join("");
}

async function loadChapterWords(lang) {
  for (const ch of S.chapters) {
    if (ch.lang !== lang || S.chapterWords.has(ch.id)) continue;
    try {
      const full = await S.db.getChapter(ch.id);
      S.chapterWords.set(ch.id, new Set(buildStructure(full.paragraphs, ch.lang).firstOcc.keys()));
    } catch {
      S.chapterWords.set(ch.id, new Set());
    }
    if (S.panel.open && S.panel.mode === "progress" && $("#prog-chapters")) $("#prog-chapters").innerHTML = chaptersProgressHTML(panelLang());
  }
}

/* ---------------- Settings ---------------- */

function modelOptions(selected) {
  const known = MODELS.some((m) => m.id === selected) || modelInfo(selected).id !== selected;
  const opt = (m) =>
    `<option value="${m.id}"${m.id === modelInfo(selected).id ? " selected" : ""}>${esc(
      t("model.option", { name: m.name, inPrice: m.inPrice, outPrice: m.outPrice, note: t(`model.note.${m.id}`) })
    )}</option>`;
  return (
    MODELS.filter((m) => !m.legacy).map(opt).join("") +
    `<optgroup label="${esc(t("model.older"))}">${MODELS.filter((m) => m.legacy).map(opt).join("")}</optgroup>` +
    (known ? "" : `<option value="${esc(selected)}" selected>${esc(selected)}</option>`) +
    `<option value="__custom">${esc(t("model.custom"))}</option>`
  );
}

function renderSettings() {
  const body = $("#drawer-body");
  if (!body || S.panel.mode !== "settings") return;
  const s = S.settings;
  const key = apiKey();
  const cm = modelInfo(s.cardModel);
  const seg = (k, opts) =>
    `<div class="pp-seg" role="radiogroup">${opts
      .map(([v, l]) => `<button role="radio" aria-checked="${s[k] === v}" class="${s[k] === v ? "on" : ""}" data-act="seg" data-key="${k}" data-val="${v}">${esc(l)}</button>`)
      .join("")}</div>`;
  const est = estimateCardCost(s.cardModel, s.cardEffort);
  const me = S.db.userInfo();
  body.innerHTML = `
    <section class="pp-sec pp-sec-first">
      <h3 class="pp-h">${esc(t("set.languages"))}</h3>
      <label class="pp-label" for="set-ui-lang">${esc(t("set.uiLang"))}</label>
      <select class="pp-input" id="set-ui-lang" data-set="uiLang">${UI_LANGS.map(
        ([code, label]) => `<option value="${code}"${code === uiLang() ? " selected" : ""}>${esc(label)}</option>`
      ).join("")}</select>
      <label class="pp-label" for="set-xl">${esc(t("set.explainLang"))}</label>
      <select class="pp-input" id="set-xl" data-set="explainLang">${langOptions(EXPLAIN_LANGS, s.explainLang, true)}</select>
      <p class="pp-note pp-mt">${esc(t("set.explainNote"))}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("key.title"))}</h3>
      <p class="pp-note">${esc(t("key.note"))}</p>
      <input class="pp-input" id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${key ? `••••••••${esc(key.slice(-4))}` : ""}">
      <div class="pp-row pp-mt">
        <button class="pp-primary" data-act="save-key">${esc(t("key.save"))}</button>
        ${key ? `<button class="pp-soft-btn" data-act="check-key">${esc(t("key.check"))}</button><button class="pp-soft-btn" data-act="clear-key">${esc(t("key.delete"))}</button>` : ""}
      </div>
      <p class="pp-note pp-mt" id="key-status">${esc(key ? t("key.saved") : t("key.none"))}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("set.cardTitle"))}</h3>
      <label class="pp-label" for="set-card-model">${esc(t("set.model"))}</label>
      <select class="pp-input" id="set-card-model" data-set="cardModel">${modelOptions(s.cardModel)}</select>
      ${
        cm.efforts
          ? `<label class="pp-label" for="set-effort">${esc(t("set.effort"))}</label>
             <select class="pp-input" id="set-effort" data-set="cardEffort">${cm.efforts
               .map((e) => `<option value="${e}"${s.cardEffort === e ? " selected" : ""}>${esc(t(`effort.${e}`))}</option>`)
               .join("")}</select>
             <p class="pp-note">${esc(t("set.effortNote"))}</p>
             <label class="pp-check"><input type="checkbox" data-set="showThinking"${s.showThinking ? " checked" : ""}> ${esc(t("set.showThinking"))}</label>`
          : cm.thinking === "manual"
            ? `<label class="pp-check"><input type="checkbox" data-set="haikuThinking"${s.haikuThinking ? " checked" : ""}> ${esc(t("set.haikuThinking"))}</label>`
            : ""
      }
      <label class="pp-check"><input type="checkbox" data-set="autoCard"${s.autoCard ? " checked" : ""}> ${esc(t("set.autoCard"))}</label>
      ${cm.custom ? "" : `<p class="pp-note">${esc(t("set.cardCost", { cost: money(est) }))}</p>`}
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("set.dictTitle"))}</h3>
      <p class="pp-note">${esc(t("set.dictNote"))}</p>
      <label class="pp-label" for="set-dict-model">${esc(t("set.dictModel"))}</label>
      <select class="pp-input" id="set-dict-model" data-set="dictModel">${modelOptions(s.dictModel)}</select>
      <label class="pp-check"><input type="checkbox" data-set="autoDict"${s.autoDict ? " checked" : ""}> ${esc(t("set.autoDict"))}</label>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("set.libraryTitle"))}</h3>
      <label class="pp-check"><input type="checkbox" data-set="share"${sharing() ? " checked" : ""}> ${esc(t("set.share"))}</label>
      <p class="pp-note pp-mt">${esc(t("set.shareNote", { name: me.name }))}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("set.reviewTitle"))}</h3>
      <label class="pp-label" for="set-review-new">${esc(t("set.reviewNew"))}</label>
      <select class="pp-input" id="set-review-new" data-set="reviewNew">${REVIEW_NEW_OPTIONS.map(
        (n) => `<option value="${n}"${s.reviewNew === n ? " selected" : ""}>${n}</option>`
      ).join("")}</select>
      <p class="pp-note pp-mt">${esc(t("set.reviewNote"))}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("set.readingTitle"))}</h3>
      <div class="pp-sec-h"><label class="pp-label" for="set-size">${esc(t("set.size"))}</label><span class="pp-note" id="size-out">${s.size} px</span></div>
      <input type="range" id="set-size" min="16" max="30" step="1" value="${s.size}" data-set="size" class="pp-range">
      <p class="pp-label">${esc(t("set.theme"))}</p>
      ${seg("theme", [["light", t("theme.light")], ["dark", t("theme.dark")]])}
      <p class="pp-label">${esc(t("set.highlight"))}</p>
      ${seg("highlight", [["all", t("hl.allBtn")], ["unlearned", t("hl.unlearnedBtn")], ["none", t("hl.noneBtn")]])}
      <p class="pp-note pp-mt">${esc(t("set.highlightNote"))}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("chapters.title"))}</h3>
      ${
        S.chapters.length
          ? S.chapters
              .map(
                (c) => `<div class="pp-ch-row"><span><span class="pp-lang-tag" title="${esc(langName(c.lang))}">${esc(langCode(c.lang))}</span> ${esc(c.title)}${S.chapter?.id === c.id ? ` <em>${esc(t("chapters.open"))}</em>` : ""}</span>
                <span class="pp-row"><button class="pp-icon-btn sm" data-act="rename-chapter" data-id="${esc(c.id)}" title="${esc(t("chapters.rename"))}" aria-label="${esc(t("chapters.rename"))}">${I.edit}</button>
                <button class="pp-icon-btn sm" data-act="delete-chapter" data-id="${esc(c.id)}" title="${esc(t("chapters.delete"))}" aria-label="${esc(t("chapters.delete"))}">${I.trash}</button></span></div>`
              )
              .join("")
          : `<p class="pp-note">${esc(t("prog.noChapters"))}</p>`
      }
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("backup.title"))}</h3>
      <p class="pp-note">${esc(t("backup.note"))}</p>
      <div class="pp-row"><button class="pp-soft-btn" data-act="export">${esc(t("backup.export"))}</button><button class="pp-soft-btn" data-act="import">${esc(t("backup.import"))}</button></div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("account.title"))}</h3>
      <p><b>${esc(me.name)}</b>${S.isAdmin ? ` <span class="pp-lang-tag">${esc(t("account.admin"))}</span>` : ""}</p>
      <p>${esc(S.email || t("account.signedIn"))}</p>
      <p class="pp-note">${esc(t("account.plan", { plan: t(`plan.${S.profile?.plan || "free"}`) }))}</p>
      <p class="pp-note pp-uid">${esc(t("account.uid"))}: <code>${esc(me.uid)}</code> <button class="pp-link" data-act="copy-uid">${esc(t("account.copy"))}</button></p>
      <button class="pp-soft-btn pp-mt" data-act="logout">${esc(t("account.logout"))}</button>
    </section>`;
}

/* ---------------- Admin panel ---------------- */

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(uiLang()) : "—");

let adminLoading = false;
async function loadAdmin(force = false) {
  if (adminLoading || (S.admin && !force)) return;
  adminLoading = true;
  if (force) {
    S.admin = null;
    renderPanel();
  }
  try {
    const [counts, users, shared] = await Promise.all([S.db.adminCounts(), S.db.adminUsers(100), S.db.adminRecentShared(50)]);
    S.admin = { counts, users, shared };
  } catch (e) {
    S.admin = { error: e.message };
  } finally {
    adminLoading = false;
    if (S.panel.open && S.panel.mode === "admin") renderAdmin();
  }
}

function renderAdmin() {
  const body = $("#drawer-body");
  if (!body || S.panel.mode !== "admin") return;
  if (!S.isAdmin) {
    body.innerHTML = `<p class="pp-note pp-pad">${esc(t("admin.only"))}</p>`;
    return;
  }
  const a = S.admin;
  if (!a) {
    body.innerHTML = `<div class="pp-pad">${skel(6)}</div>`;
    loadAdmin();
    return;
  }
  if (a.error) {
    body.innerHTML = `<div class="pp-pad"><p class="pp-error-line">${esc(a.error)}</p><button class="pp-soft-btn pp-mt" data-act="admin-refresh">${esc(t("common.retry"))}</button></div>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const userHTML = (u) => `<div class="pp-adm-item">
      <div class="pp-adm-h"><b>${esc(u.name || "—")}</b><span class="pp-note">${esc(u.email || "")}</span></div>
      <p class="pp-note">${esc(t("admin.userLine", { created: fmtDate(u.created), seen: fmtDate(u.lastSeen), words: u.words || 0, cards: u.cards || 0 }))}</p>
      <div class="pp-row pp-adm-plan-row">
        <select class="pp-input pp-adm-plan" data-uid="${esc(u.uid)}" aria-label="${esc(t("admin.plan"))}">${["free", "pro"]
          .map((p) => `<option value="${p}"${(u.plan || "free") === p ? " selected" : ""}>${esc(t(`plan.${p}`))}</option>`)
          .join("")}</select>
        <input class="pp-input pp-adm-until" type="date" data-uid="${esc(u.uid)}" value="${esc(String(u.planUntil || "").slice(0, 10))}" min="${today}" aria-label="${esc(t("admin.until"))}" title="${esc(t("admin.until"))}">
        <button class="pp-soft-btn" data-act="admin-plan" data-uid="${esc(u.uid)}">${esc(t("common.save"))}</button>
      </div>
    </div>`;
  const sharedHTML = (it) => `<div class="pp-adm-item">
      <div class="pp-lib-h">
        <b ${readerLangAttrs(it.lang)}>${esc(it.word)}</b>
        <span class="pp-lang-tag" title="${esc(`${langName(it.lang)} → ${langName(it.xl)}`)}">${esc(`${langCode(it.lang)}→${langCode(it.xl)}`)}</span>
        <span class="pp-note">${esc(it.byName || "")}</span>
        <span class="pp-like is-own">${I.heart}<b>${fmtInt(it.likes)}</b></span>
      </div>
      ${it.card?.translation ? `<p class="pp-lib-tr">${esc(it.card.translation)}</p>` : ""}
      <p class="pp-lib-preview">${esc(String(it.card?.etymology || it.card?.fact || "").slice(0, 160))}</p>
      <div class="pp-row"><span class="pp-note">${esc(fmtDate(it.created))}</span><button class="pp-link pp-danger" data-act="admin-delete" data-id="${esc(it.id)}">${esc(t("lib.delete"))}</button></div>
    </div>`;
  body.innerHTML = `
    <section class="pp-sec pp-sec-first">
      <div class="pp-sec-h"><h3 class="pp-h">${esc(t("admin.overview"))}</h3><button class="pp-link" data-act="admin-refresh">${esc(t("admin.refresh"))}</button></div>
      <div class="pp-rv-stats">
        <div><b>${fmtInt(a.counts.users)}</b><span>${esc(t("admin.users"))}</span></div>
        <div><b>${fmtInt(a.counts.cards)}</b><span>${esc(t("admin.sharedCards"))}</span></div>
      </div>
      <p class="pp-note pp-mt">${esc(t("admin.quotaNote"))}</p>
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("admin.usersTitle"))}</h3>
      <p class="pp-note">${esc(t("admin.proNote"))}</p>
      ${a.users.map(userHTML).join("") || `<p class="pp-note">${esc(t("admin.noUsers"))}</p>`}
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">${esc(t("admin.sharedTitle"))}</h3>
      ${a.shared.map(sharedHTML).join("") || `<p class="pp-note">${esc(t("admin.noShared"))}</p>`}
    </section>`;
}

async function savePlan(uid) {
  const plan = $(`.pp-adm-plan[data-uid="${cssEsc(uid)}"]`)?.value || "free";
  const until = $(`.pp-adm-until[data-uid="${cssEsc(uid)}"]`)?.value || "";
  const planUntil = plan === "free" || !until ? null : new Date(`${until}T23:59:59Z`).toISOString();
  try {
    await S.db.adminSetPlan(uid, plan, planUntil);
    const u = S.admin?.users.find((x) => x.uid === uid);
    if (u) Object.assign(u, { plan, planUntil });
    if (uid === S.db.userInfo().uid) S.profile = { ...(S.profile || {}), plan, planUntil };
    toast(t("admin.saved"));
  } catch (e) {
    toast(t("admin.saveFailed", { msg: e.message }));
  }
}

function saveKey() {
  const input = $("#api-key");
  const v = (input?.value || "").trim();
  if (!v || v.startsWith("••••")) return toast(t("key.pasteWhole"));
  if (!v.startsWith("sk-ant-") && !confirm(t("key.confirmOdd"))) return;
  localStorage.setItem(LS.api, v);
  renderSettings();
  toast(t("key.savedToast"));
  updateChapterStats();
  if (S.st && S.settings.autoDict) prepareDictionary();
}

async function checkKeyAction() {
  const st = $("#key-status");
  if (st) st.textContent = t("key.checking");
  try {
    await checkKey(apiKey());
    if (st) st.textContent = t("key.works");
  } catch (e) {
    if (st) st.textContent = e.message;
  }
}

async function exportBackup() {
  try {
    toast(t("backup.preparing"));
    const data = await S.db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `palabra-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(t("backup.done"));
  } catch (e) {
    toast(t("backup.failed", { msg: e.message }));
  }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "palabra-por-palabra") throw new Error(t("backup.notOurs"));
    const ok = confirm(
      t("backup.confirmImport", {
        date: String(data.exported_at || "").slice(0, 10),
        chapters: data.chapters?.length || 0,
        words: data.words?.length || 0,
      })
    );
    if (!ok) return;
    toast(t("backup.importing"), 10000);
    await S.db.importAll(data);
    toast(t("backup.imported"));
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    toast(t("backup.importFailed", { msg: e.message }));
  }
}

if (!window.__PPP_TEST__) boot();
