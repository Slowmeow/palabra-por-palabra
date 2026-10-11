import { reflowText, buildStructure, contextAround, plural, esc } from "./text.js";
import {
  MODELS, EFFORTS, FACT_TYPES, modelInfo, generateCard, explainContext, lookupWords, checkKey, estimateCardCost,
} from "./claude.js";
import { I } from "./icons.js";

/* ---------------- Константы и состояние ---------------- */

const CFG = window.PPP_CONFIG || {};
const LS = { url: "ppp_supabase_url", key: "ppp_supabase_key", api: "ppp_anthropic_key", theme: "ppp_theme" };
const DEFAULTS = {
  size: 21,
  theme: "light",
  highlight: "unlearned",
  cardModel: "claude-opus-5",
  cardEffort: "high",
  showThinking: true,
  haikuThinking: false,
  autoCard: false,
  dictModel: "claude-haiku-4-5-20251001",
  autoDict: true,
  lastChapter: null,
  spent: 0,
};
const LEVEL_LABEL = { 5: "не знаю", 4: "смутно", 3: "узнаю", 2: "почти", 1: "знаю" };
const HL_LABEL = { all: "все слова", unlearned: "неизученные", none: "выключена" };
const HL_ORDER = ["all", "unlearned", "none"];
const MOBILE_MAX = 759;
const DICT_BATCH = 60;
const FACT_META = {
  смешной: ["😄", "Смешной факт", "fun"],
  грустный: ["🥀", "Грустный факт", "sad"],
  жуткий: ["👻", "Жуткий факт", "creepy"],
  удивительный: ["✨", "Удивительный факт", "wow"],
  исторический: ["📜", "Исторический факт", "hist"],
};

const S = {
  db: null,
  email: "",
  bound: false,
  settings: { ...DEFAULTS },
  chapters: [],
  chapter: null,
  st: null,
  chapterWords: new Map(),
  words: new Map(),
  full: new Map(),
  sel: null,
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
  vocab: { q: "", level: 0 },
  renderedWord: null,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
const apiKey = () => localStorage.getItem(LS.api) || "";
const rowOf = (w) => S.words.get(w) || { word: w, level: 5, quick: null, has_card: false, first_chapter: null, learned_at: null };
const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${(n || 0).toFixed(2)}`);
const fmtInt = (n) => Number(n || 0).toLocaleString("ru-RU");
const isSelected = (w) => !!S.sel && S.sel.w === w && S.panel.open && S.panel.mode === "word";
const chapterTitle = (id) => S.chapters.find((c) => c.id === id)?.title || "";
const skel = (n) =>
  Array.from({ length: n }, (_, i) => `<div class="pp-sk" style="width:${[92, 78, 86, 64, 82, 70][i % 6]}%"></div>`).join("");

let toastTimer;
function toast(msg, ms = 4200) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
  localStorage.setItem(LS.theme, t === "dark" ? "dark" : "light");
}

let settingsTimer;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    S.db?.saveSettings(S.settings).catch((e) => toast(`Настройки не сохранились: ${e.message}`));
  }, 800);
}

function addSpent(cost) {
  if (!cost) return;
  S.settings.spent = (S.settings.spent || 0) + cost;
  saveSettingsSoon();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return toast("Этот браузер не умеет озвучивать текст");
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "es-ES";
    u.rate = 0.9;
    const voice = synth.getVoices().find((v) => (v.lang || "").toLowerCase().startsWith("es"));
    if (voice) u.voice = voice;
    synth.speak(u);
  } catch {
    /* озвучка недоступна */
  }
}

/* ---------------- Запуск, подключение, вход ---------------- */

export async function boot() {
  applyTheme(localStorage.getItem(LS.theme) || "light");
  bindOnce();
  const url = (CFG.SUPABASE_URL || localStorage.getItem(LS.url) || "").trim();
  const key = (CFG.SUPABASE_PUBLISHABLE_KEY || localStorage.getItem(LS.key) || "").trim();
  if (!url || !key) return renderSetup();
  let makeDb;
  try {
    ({ makeDb } = await import("./db.js"));
  } catch {
    return renderMessage("Библиотека базы данных не загрузилась", "Проверьте интернет и обновите страницу.");
  }
  try {
    S.db = makeDb(url, key);
  } catch (e) {
    return renderSetup(`Подключиться не получилось: ${e.message}`);
  }
  const session = await S.db.session().catch(() => null);
  if (!session) return renderLogin();
  return startApp();
}

function authShell(inner) {
  return `<main class="pp-auth"><div class="pp-auth-card">
    <div class="pp-brand"><span class="pp-logo" aria-hidden="true">ñ</span><span class="pp-brand-t">Palabra por palabra</span></div>
    ${inner}
  </div></main>`;
}

function renderMessage(title, text) {
  $("#app").innerHTML = authShell(`<h1 class="pp-auth-h">${esc(title)}</h1><p class="pp-lead">${esc(text)}</p>`);
}

function renderSetup(err = "") {
  $("#app").innerHTML = authShell(`
    <h1 class="pp-auth-h">Подключите базу данных</h1>
    <p class="pp-lead">Вставьте Project URL и publishable key из Supabase. Чтобы не вводить их на каждом устройстве, пропишите их в файле config.js.</p>
    ${err ? `<p class="pp-error-line">${esc(err)}</p>` : ""}
    <form id="setup-form" class="pp-form-plain">
      <label class="pp-label" for="su-url">Project URL</label>
      <input class="pp-input" id="su-url" required placeholder="https://xxxx.supabase.co" autocomplete="off" spellcheck="false">
      <label class="pp-label" for="su-key">Publishable key</label>
      <input class="pp-input" id="su-key" required placeholder="sb_publishable_…" autocomplete="off" spellcheck="false">
      <button class="pp-primary" type="submit">Подключить</button>
    </form>`);
  $("#setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = $("#su-url").value.trim().replace(/\/+$/, "");
    const key = $("#su-key").value.trim();
    if (/^sb_secret_/.test(key)) return renderSetup("Это секретный ключ. Его нельзя вставлять на сайт: нужен publishable key.");
    if (/^sk-ant-/.test(key)) return renderSetup("Это ключ Anthropic. Здесь нужен ключ Supabase, а ключ Anthropic вводится в настройках после входа.");
    if (!/^https:\/\/.+/.test(url)) return renderSetup("Project URL должен начинаться с https://");
    localStorage.setItem(LS.url, url);
    localStorage.setItem(LS.key, key);
    boot();
  });
}

function renderLogin(err = "") {
  const fromConfig = !!(CFG.SUPABASE_URL && CFG.SUPABASE_PUBLISHABLE_KEY);
  $("#app").innerHTML = authShell(`
    <h1 class="pp-auth-h">Вход</h1>
    <p class="pp-lead">Войдите с почтой и паролем, которые вы создали в Supabase.</p>
    ${err ? `<p class="pp-error-line">${esc(err)}</p>` : ""}
    <form id="login-form" class="pp-form-plain">
      <label class="pp-label" for="li-email">Почта</label>
      <input class="pp-input" id="li-email" type="email" required autocomplete="username">
      <label class="pp-label" for="li-pass">Пароль</label>
      <input class="pp-input" id="li-pass" type="password" required autocomplete="current-password">
      <button class="pp-primary" type="submit" id="li-btn">Войти</button>
    </form>
    ${fromConfig ? "" : `<button class="pp-link pp-auth-alt" data-act="reset-conn">Подключить другую базу данных</button>`}`);
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#li-btn");
    btn.disabled = true;
    btn.textContent = "Вхожу…";
    try {
      await S.db.signIn($("#li-email").value.trim(), $("#li-pass").value);
      await startApp();
    } catch (er) {
      const m = String(er?.message || er);
      renderLogin(/invalid login/i.test(m) ? "Неверная почта или пароль." : `Войти не получилось: ${m}`);
    }
  });
}

function shellHTML() {
  return `
  <div class="pp-shell" id="shell">
    <header class="pp-top">
      <div class="pp-brand"><span class="pp-logo" aria-hidden="true">ñ</span><span class="pp-brand-t">Palabra por palabra</span></div>
      <div class="pp-select-wrap" id="chapter-picker" hidden>
        <select class="pp-select" id="chapter-select" aria-label="Глава"></select>
        <span class="pp-select-ico">${I.down}</span>
      </div>
      <div class="pp-actions">
        <span class="pp-pill" id="top-progress" hidden></span>
        <button class="pp-hl-btn" data-act="cycle-highlight" id="hl-btn" title="Сменить подсветку слов">${I.highlight}<span id="hl-label"></span></button>
        <button class="pp-icon-btn" data-act="add-chapter" title="Добавить главу" aria-label="Добавить главу">${I.plus}</button>
        <button class="pp-icon-btn" data-act="panel" data-mode="vocab" title="Мой словарь" aria-label="Мой словарь">${I.book}<span class="pp-count" id="vocab-count" hidden></span></button>
        <button class="pp-icon-btn" data-act="panel" data-mode="progress" title="Прогресс" aria-label="Прогресс">${I.chart}</button>
        <button class="pp-icon-btn" data-act="panel" data-mode="settings" title="Настройки" aria-label="Настройки">${I.gear}</button>
      </div>
    </header>
    <main id="main"></main>
  </div>
  <aside class="pp-drawer" id="drawer" aria-hidden="true">
    <div class="pp-grab"></div>
    <div class="pp-drawer-h"><span id="drawer-title"></span><button class="pp-icon-btn sm" data-act="close-panel" aria-label="Закрыть панель">${I.x}</button></div>
    <div class="pp-drawer-b" id="drawer-body"></div>
  </aside>
  <div id="modal-root"></div>
  <div class="pp-toast" id="toast" role="status" hidden></div>`;
}

function setMain(html) {
  const m = $("#main");
  if (m) m.innerHTML = html;
}

async function startApp() {
  $("#app").innerHTML = shellHTML();
  setMain(`<div class="pp-boot"><span class="pp-spin">${I.loader}</span><span>Загружаю главы и слова…</span></div>`);
  try {
    const [chapters, words, settings, email] = await Promise.all([
      S.db.listChapters(),
      S.db.loadWords(),
      S.db.loadSettings(),
      S.db.userEmail().catch(() => ""),
    ]);
    S.chapters = chapters;
    S.words = new Map(words.map((r) => [r.word, r]));
    S.settings = { ...DEFAULTS, ...(settings || {}) };
    S.email = email;
    applyTheme(S.settings.theme);
    applyReaderSettings();
    updateChapterSelect();
    updateVocabCount();
    const target = chapters.find((c) => c.id === S.settings.lastChapter)?.id || chapters.at(-1)?.id;
    if (target) await openChapter(target);
    else renderEmpty();
  } catch (e) {
    setMain(`<div class="pp-empty"><div class="pp-empty-in">
      <h1 class="pp-hero">Данные не загрузились</h1>
      <p class="pp-lead">${esc(e.message)}</p>
      <p class="pp-lead">Если сайтом давно не пользовались, бесплатный проект Supabase мог уснуть. Откройте панель Supabase, восстановите проект и обновите страницу.</p>
      <button class="pp-primary" data-act="reload">Обновить страницу</button>
    </div></div>`);
  }
}

/* ---------------- События ---------------- */

function bindOnce() {
  if (S.bound) return;
  S.bound = true;
  const app = $("#app");
  app.addEventListener("click", onClick);
  app.addEventListener("change", onChange);
  app.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
  setInterval(tickGen, 1000);
}

const ACTIONS = {
  reload: () => location.reload(),
  "reset-conn": () => {
    localStorage.removeItem(LS.url);
    localStorage.removeItem(LS.key);
    location.reload();
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
    toast(`Подсветка: ${HL_LABEL[S.settings.highlight]}`, 1800);
    if (S.panel.open && S.panel.mode === "settings") renderSettings();
  },
  level: (a) => S.sel && setLevel(S.sel.w, Number(a.dataset.level)),
  speak: (a) => speak(a.dataset.text),
  occ: (a) => jumpOcc(Number(a.dataset.dir)),
  "gen-card": () => generateForSelected(),
  "gen-cancel": () => S.sel && S.gen.get(S.sel.w)?.abort.abort(),
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
  "explain-here": () => explainHere(),
  "retry-quick": () => S.sel && ensureQuick(S.sel.w, true),
  edit: () => {
    S.editing = true;
    renderWordView();
  },
  "edit-cancel": () => {
    S.editing = false;
    renderWordView();
  },
  "edit-save": () => saveEdit(),
  "open-word": (a) => openWordFromList(a.dataset.w),
  "vocab-level": (a) => {
    S.vocab.level = Number(a.dataset.level);
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
    if (!confirm("Удалить ключ Anthropic из этого браузера?")) return;
    localStorage.removeItem(LS.api);
    renderSettings();
  },
  "rename-chapter": (a) => renameChapter(a.dataset.id),
  "delete-chapter": (a) => deleteChapter(a.dataset.id),
  export: () => exportBackup(),
  import: () => $("#import-file")?.click(),
  "reset-spent": () => {
    if (!confirm("Обнулить счётчик потраченных денег?")) return;
    S.settings.spent = 0;
    saveSettingsSoon();
    renderPanel();
  },
  logout: async () => {
    await S.db.signOut();
    location.reload();
  },
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

function onChange(e) {
  const t = e.target;
  if (t.id === "chapter-select") return void openChapter(t.value);
  if (t.id === "add-join") return updateAddPreview();
  if (t.id === "import-file") return void importBackup(t.files?.[0]);
  const k = t.dataset.set;
  if (!k) return;
  let val = t.type === "checkbox" ? t.checked : t.type === "range" ? Number(t.value) : t.value;
  if ((k === "cardModel" || k === "dictModel") && val === "__custom") {
    const id = prompt("Введите ID модели Claude, например claude-opus-5");
    if (!id || !id.trim()) return renderSettings();
    val = id.trim();
  }
  S.settings[k] = val;
  if (k === "cardModel") {
    const inf = modelInfo(val);
    if (inf.efforts && !inf.efforts.includes(S.settings.cardEffort)) S.settings.cardEffort = "high";
  }
  applyReaderSettings();
  saveSettingsSoon();
  if (["cardModel", "cardEffort", "dictModel", "showThinking", "haikuThinking"].includes(k)) renderSettings();
}

let previewTimer;
function onInput(e) {
  const t = e.target;
  if (t.dataset.role === "vocab-search") {
    S.vocab.q = t.value;
    renderVocabList();
  } else if (t.id === "add-text") {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateAddPreview, 150);
  } else if (t.dataset.set === "size") {
    S.settings.size = Number(t.value);
    applyReaderSettings();
    const out = $("#size-out");
    if (out) out.textContent = `${t.value} px`;
  }
}

function onKey(e) {
  if (!S.db) return;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if (e.key === "Escape") {
    if ($("#modal-root .pp-modal")) closeModal();
    else if (S.panel.open && !typing) closePanel();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!S.panel.open || S.panel.mode !== "word" || !S.sel || S.editing) return;
  if (/^[1-5]$/.test(e.key)) {
    e.preventDefault();
    setLevel(S.sel.w, Number(e.key));
  } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && S.sel.sid != null) {
    e.preventDefault();
    moveSelection(e.key === "ArrowRight" ? 1 : -1);
  }
}

function tickGen() {
  if (!S.sel) return;
  const job = S.gen.get(S.sel.w);
  const el = $("#gen-elapsed");
  if (job && el) el.textContent = `${Math.round((Date.now() - job.started) / 1000)} с`;
}

/* ---------------- Главы и чтение ---------------- */

function updateChapterSelect() {
  const sel = $("#chapter-select");
  if (!sel) return;
  $("#chapter-picker").hidden = !S.chapters.length;
  sel.innerHTML = S.chapters
    .map((c) => `<option value="${esc(c.id)}"${S.chapter?.id === c.id ? " selected" : ""}>${esc(c.title)}</option>`)
    .join("");
}

function updateVocabCount() {
  const el = $("#vocab-count");
  if (!el) return;
  let n = 0;
  for (const r of S.words.values()) if (r.level === 1) n++;
  el.hidden = n === 0;
  el.textContent = n > 999 ? `${Math.floor(n / 1000)}k` : String(n);
  el.title = `Выучено слов: ${n}`;
}

function applyReaderSettings() {
  applyTheme(S.settings.theme);
  const r = $("#reader");
  if (r) {
    r.style.fontSize = `${S.settings.size}px`;
    r.className = `pp-reader hl-${S.settings.highlight}`;
  }
  $$(".pp-drawer .pp-sent[data-hl]").forEach((p) => (p.className = `pp-sent hl-${S.settings.highlight}`));
  const label = $("#hl-label");
  if (label) label.textContent = `Подсветка: ${HL_LABEL[S.settings.highlight]}`;
}

async function openChapter(id) {
  if (S.editing && !confirm("Выйти из редактирования без сохранения?")) return updateChapterSelect();
  stopDictionary(true);
  setMain(`<div class="pp-boot"><span class="pp-spin">${I.loader}</span><span>Открываю главу…</span></div>`);
  try {
    const ch = await S.db.getChapter(id);
    S.chapter = ch;
    S.st = buildStructure(ch.paragraphs);
    S.chapterWords.set(id, new Set(S.st.firstOcc.keys()));
    S.editing = false;
    if (S.panel.open && S.panel.mode === "word") closePanel(true);
    S.sel = null;
    S.settings.lastChapter = id;
    saveSettingsSoon();
    renderChapter();
    updateChapterSelect();
    window.scrollTo(0, 0);
    if (S.settings.autoDict && apiKey()) prepareDictionary();
  } catch (e) {
    setMain(`<div class="pp-empty"><div class="pp-empty-in"><h1 class="pp-hero">Глава не открылась</h1><p class="pp-lead">${esc(e.message)}</p></div></div>`);
  }
}

function renderEmpty() {
  S.chapter = null;
  S.st = null;
  setMain(`<div class="pp-empty"><div class="pp-empty-in">
    <h1 class="pp-hero">У каждого слова своя история</h1>
    <p class="pp-lead">Вставьте главу на испанском. Все слова в ней загорятся: чем ярче слово, тем хуже вы его знаете. Нажмите на слово, чтобы увидеть перевод и произношение, поставить уровень от 5 до 1 и попросить Claude подробно его разобрать.</p>
    ${apiKey() ? "" : `<p class="pp-note">Сначала добавьте API-ключ Anthropic в <button class="pp-link" data-act="panel" data-mode="settings">настройках</button>, иначе переводы не появятся.</p>`}
    ${addFormHTML(true)}
  </div></div>`);
  updateChapterSelect();
}

function renderChapter() {
  const st = S.st;
  const html = st.paras
    .map((p) => {
      let inner = "";
      for (const s of p.sents) {
        for (let ti = 0; ti < s.tokens.length; ti++) {
          const t = s.tokens[ti];
          inner += t.w
            ? `<span class="pp-wd l${rowOf(t.w).level}" data-w="${esc(t.w)}" data-s="${s.sid}" data-i="${ti}">${esc(t.t)}</span>`
            : esc(t.t);
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
    <article class="pp-reader hl-${esc(S.settings.highlight)}" id="reader" lang="es" style="font-size:${Number(S.settings.size)}px">${html}</article>
    <div class="pp-end"><span>Конец главы.</span><button class="pp-link" data-act="add-chapter">Добавить следующую главу</button></div>`);
  updateChapterStats();
}

function levelCounts(words) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const w of words) c[rowOf(w).level]++;
  return c;
}

function levelBarHTML(c) {
  return [1, 2, 3, 4, 5]
    .map((l) => (c[l] ? `<i class="lb${l}" style="flex-grow:${c[l]}" title="Уровень ${l}: ${c[l]}"></i>` : ""))
    .join("");
}

function updateChapterStats() {
  if (!S.st || !$("#chap-stats")) return;
  const words = [...S.st.firstOcc.keys()];
  const c = levelCounts(words);
  const total = words.length;
  $("#chap-stats").innerHTML = `Выучено <b>${c[1]}</b> из <b>${total}</b> ${plural(total, "слова", "слов", "слов")} главы, изучаются <b>${c[2] + c[3] + c[4]}</b>`;
  $("#chap-levelbar").innerHTML = levelBarHTML(c);
  const noQuick = words.filter((w) => !rowOf(w).quick).length;
  const unanalyzed = words.filter((w) => rowOf(w).level > 1 && !rowOf(w).has_card).length;
  let actions = "";
  if (S.dict.running) actions += `<button class="pp-soft-btn" data-act="stop-dict">Остановить словарь</button>`;
  else if (noQuick && apiKey())
    actions += `<button class="pp-soft-btn" data-act="prepare-dict" title="Быстрые переводы и произношение для всех слов главы">${I.book} Подготовить словарь (${noQuick})</button>`;
  if (S.bulk.running) actions += `<button class="pp-soft-btn" data-act="stop-bulk">Остановить разбор</button>`;
  else if (unanalyzed && apiKey())
    actions += `<button class="pp-soft-btn" data-act="bulk" title="Подробный разбор всех слов главы, кроме выученных">${I.sparkles} Разобрать неизученные (${unanalyzed})</button>`;
  $("#chap-actions").innerHTML = actions;
}

function updateTopProgress() {
  const el = $("#top-progress");
  if (!el) return;
  const parts = [];
  if (S.dict.running) parts.push(`словарь ${S.dict.done} из ${S.dict.total}`);
  if (S.bulk.running) parts.push(`разбор ${S.bulk.done} из ${S.bulk.total}`);
  el.hidden = !parts.length;
  el.innerHTML = parts.length ? `<span class="pp-spin">${I.loader}</span>${parts.join(", ")}` : "";
}

function refreshWordSpans(w) {
  const lvl = rowOf(w).level;
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

function scrollToToken(sid, ti) {
  const el = $(`.pp-reader [data-s="${sid}"][data-i="${ti}"]`);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const mobile = window.innerWidth <= MOBILE_MAX;
  const bottom = mobile ? window.innerHeight * 0.26 : window.innerHeight - 60;
  if (r.top < 80 || r.bottom > bottom) el.scrollIntoView({ behavior: "smooth", block: mobile ? "start" : "center" });
}

/* ---------------- Добавление главы ---------------- */

function addFormHTML(first) {
  return `<div class="pp-form">
    <label class="pp-label" for="add-title">Название главы, если хотите своё</label>
    <input class="pp-input" id="add-title" placeholder="Например: Capítulo 2">
    <label class="pp-label" for="add-text">Текст главы</label>
    <textarea class="pp-textarea" id="add-text" lang="es" placeholder="Вставьте сюда текст на испанском"></textarea>
    <label class="pp-check"><input type="checkbox" id="add-join" checked> Склеивать строки, разорванные при копировании из PDF</label>
    <div class="pp-form-foot">
      <p class="pp-note" id="add-preview">После вставки здесь появится, сколько в главе новых для вас слов.</p>
      <div class="pp-row">
        ${first ? "" : `<button class="pp-soft-btn" data-act="modal-close">Отмена</button>`}
        <button class="pp-primary" data-act="add-submit" id="add-submit" disabled>Добавить главу</button>
      </div>
    </div>
  </div>`;
}

function openAddChapter() {
  if (!S.chapters.length && $("#add-text")) {
    $("#add-text").focus();
    return;
  }
  $("#modal-root").innerHTML = `<div class="pp-modal" data-act="modal-backdrop">
    <div class="pp-modal-card" role="dialog" aria-modal="true" aria-label="Новая глава">
      <div class="pp-drawer-h"><span>Новая глава</span><button class="pp-icon-btn sm" data-act="modal-close" aria-label="Закрыть">${I.x}</button></div>
      ${addFormHTML(false)}
    </div></div>`;
  $("#add-text")?.focus();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
}

function updateAddPreview() {
  const text = $("#add-text")?.value || "";
  const btn = $("#add-submit");
  const out = $("#add-preview");
  if (!btn || !out) return;
  if (!text.trim()) {
    btn.disabled = true;
    out.textContent = "После вставки здесь появится, сколько в главе новых для вас слов.";
    return;
  }
  const paras = reflowText(text, $("#add-join")?.checked);
  const st = buildStructure(paras);
  let fresh = 0;
  for (const w of st.firstOcc.keys()) if (!S.words.has(w)) fresh++;
  btn.disabled = !paras.length;
  out.innerHTML = `Абзацев: <b>${paras.length}</b>, слов: <b>${fmtInt(st.tokenCount)}</b>, уникальных: <b>${fmtInt(st.firstOcc.size)}</b>, новых для вас: <b class="pp-accent">${fmtInt(fresh)}</b>`;
}

async function submitChapter() {
  const text = $("#add-text")?.value || "";
  const paragraphs = reflowText(text, $("#add-join")?.checked);
  if (!paragraphs.length) return;
  const btn = $("#add-submit");
  btn.disabled = true;
  btn.textContent = "Сохраняю…";
  try {
    const heading = /^cap[ií]tulo\b/i.test(paragraphs[0]) ? paragraphs[0] : "";
    const title = (($("#add-title")?.value || "").trim() || heading || `Глава ${S.chapters.length + 1}`).slice(0, 120);
    const position = S.chapters.reduce((m, c) => Math.max(m, c.position || 0), 0) + 1;
    const ch = await S.db.addChapter(title, paragraphs, position);
    const st = buildStructure(paragraphs);
    const fresh = [...st.firstOcc.keys()].filter((w) => !S.words.has(w));
    await S.db.registerWords(fresh, ch.id);
    for (const w of fresh) S.words.set(w, { word: w, level: 5, quick: null, has_card: false, first_chapter: ch.id, learned_at: null });
    S.chapters.push(ch);
    closeModal();
    await openChapter(ch.id);
    toast(`Глава добавлена. Уникальных слов: ${st.firstOcc.size}, новых для вас: ${fresh.length}`);
  } catch (e) {
    toast(`Глава не добавилась: ${e.message}`);
    btn.disabled = false;
    btn.textContent = "Добавить главу";
  }
}

async function renameChapter(id) {
  const ch = S.chapters.find((c) => c.id === id);
  if (!ch) return;
  const title = prompt("Новое название главы", ch.title);
  if (!title || !title.trim()) return;
  try {
    await S.db.renameChapter(id, title.trim());
    ch.title = title.trim();
    updateChapterSelect();
    renderSettings();
  } catch (e) {
    toast(`Название не сохранилось: ${e.message}`);
  }
}

async function deleteChapter(id) {
  const ch = S.chapters.find((c) => c.id === id);
  if (!ch || !confirm(`Удалить главу «${ch.title}»? Слова, уровни и карточки останутся в словаре.`)) return;
  try {
    await S.db.deleteChapter(id);
    S.chapters = S.chapters.filter((c) => c.id !== id);
    S.chapterWords.delete(id);
    for (const r of S.words.values()) if (r.first_chapter === id) r.first_chapter = null;
    updateChapterSelect();
    if (S.chapter?.id === id) {
      if (S.chapters.length) await openChapter(S.chapters.at(-1).id);
      else renderEmpty();
    }
    renderSettings();
    toast("Глава удалена");
  } catch (e) {
    toast(`Глава не удалилась: ${e.message}`);
  }
}

/* ---------------- Панель ---------------- */

function openPanel(mode) {
  S.panel = { open: true, mode };
  const d = $("#drawer");
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  $("#shell").classList.add("shift");
  $("#drawer-title").textContent = { word: "Слово", vocab: "Мой словарь", progress: "Прогресс", settings: "Настройки" }[mode];
  $$(".pp-actions [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderPanel();
  markSelection();
}

function closePanel(force = false) {
  if (!force && S.editing && !confirm("Выйти из редактирования без сохранения?")) return;
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
    if (S.editing && !confirm("Выйти из редактирования без сохранения?")) return;
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
}

/* ---------------- Слово ---------------- */

function onWordClick(el) {
  const sid = Number(el.dataset.s);
  const ti = Number(el.dataset.i);
  const inReader = !!el.closest(".pp-reader");
  selectWord(el.dataset.w, sid, ti);
  if (inReader && window.innerWidth <= MOBILE_MAX) {
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.24) window.scrollBy({ top: r.top - 84, behavior: "smooth" });
  }
}

function selectWord(w, sid, ti) {
  if (S.editing && S.sel?.w !== w && !confirm("Выйти из редактирования без сохранения?")) return;
  const tok = S.st?.sentTokens[sid]?.[ti];
  if (!tok) return;
  S.sel = { w, sid, ti, surface: tok.t };
  S.editing = false;
  S.regenOpen = false;
  S.ctxErr = null;
  openPanel("word");
  ensureQuick(w);
  ensureFull(w);
  const row = rowOf(w);
  if (S.settings.autoCard && apiKey() && !row.has_card && row.level > 1 && !S.gen.has(w)) generateForSelected();
}

function openWordFromList(w) {
  const first = S.st?.occ.get(w)?.[0];
  if (first) {
    selectWord(w, first[0], first[1]);
    requestAnimationFrame(() => scrollToToken(first[0], first[1]));
    return;
  }
  S.sel = { w, sid: null, ti: null, surface: w };
  S.editing = false;
  S.regenOpen = false;
  openPanel("word");
  ensureQuick(w);
  ensureFull(w);
}

function jumpOcc(dir) {
  if (!S.sel || S.sel.sid == null) return;
  const list = S.st.occ.get(S.sel.w) || [];
  if (list.length < 2) return;
  const i = list.findIndex(([s, t]) => s === S.sel.sid && t === S.sel.ti);
  const [sid, ti] = list[(i + dir + list.length) % list.length];
  selectWord(S.sel.w, sid, ti);
  scrollToToken(sid, ti);
}

function moveSelection(dir) {
  const list = S.st.tokenList;
  let i = list.findIndex(([s, t]) => s === S.sel.sid && t === S.sel.ti);
  for (let k = 0; k < list.length; k++) {
    i += dir;
    if (i < 0 || i >= list.length) return;
    const [s, t] = list[i];
    const w = S.st.sentTokens[s][t].w;
    if (S.settings.highlight !== "all" && rowOf(w).level === 1) continue;
    selectWord(w, s, t);
    scrollToToken(s, t);
    return;
  }
}

async function setLevel(w, level) {
  const prev = rowOf(w);
  if (prev.level === level) return;
  const learned_at = level === 1 ? new Date().toISOString() : null;
  S.words.set(w, { ...prev, level, learned_at });
  afterLevelChange(w);
  try {
    await S.db.saveWord({ word: w, level, learned_at });
  } catch (e) {
    S.words.set(w, prev);
    afterLevelChange(w);
    toast(`Уровень не сохранился: ${e.message}`);
  }
}

function afterLevelChange(w) {
  refreshWordSpans(w);
  updateChapterStats();
  updateVocabCount();
  if (S.sel?.w === w) {
    const lvl = rowOf(w).level;
    $$("#drawer-body .pp-level").forEach((b) => {
      const on = Number(b.dataset.level) === lvl;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
}

async function ensureQuick(w, force = false) {
  if (rowOf(w).quick || S.quickBusy.has(w) || !apiKey()) return;
  if (!force && S.quickErr.has(w)) return;
  const sid = S.sel?.w === w && S.sel.sid != null ? S.sel.sid : S.st?.firstOcc.get(w)?.sid;
  const sentence = sid != null ? S.st.sentences[sid].trim().slice(0, 200) : "";
  S.quickBusy.add(w);
  S.quickErr.delete(w);
  patchQuick(w);
  try {
    const res = await lookupWords({ apiKey: apiKey(), model: S.settings.dictModel, items: [{ word: w, sentence }] });
    const q = res.map.get(w) || [...res.map.values()][0];
    if (!q) throw new Error("словарь не вернул перевод");
    await S.db.saveWord({ word: w, quick: q });
    S.words.set(w, { ...rowOf(w), quick: q });
    const f = S.full.get(w);
    if (f) f.quick = q;
    addSpent(res.cost);
  } catch (e) {
    S.quickErr.set(w, e.message || String(e));
  } finally {
    S.quickBusy.delete(w);
    patchQuick(w);
    updateChapterStats();
  }
}

function patchQuick(w) {
  if (!isSelected(w) || S.editing) return;
  const el = $("#wv-quick");
  if (el) el.innerHTML = quickHTML(w, rowOf(w));
}

async function ensureFull(w) {
  if (S.full.has(w)) return;
  if (!S.words.has(w)) {
    S.full.set(w, { word: w, card: null, contexts: [], notes: null });
    return;
  }
  try {
    const row = await S.db.getWordFull(w);
    if (!S.full.has(w)) S.full.set(w, row || { word: w, card: null, contexts: [], notes: null });
    if (isSelected(w) && !S.editing) renderWordView();
  } catch (e) {
    toast(`Карточка не загрузилась: ${e.message}`);
  }
}

function generateForSelected(wish = "") {
  const sel = S.sel;
  if (!sel) return;
  let src = null;
  if (sel.sid != null) {
    src = { sentence: S.st.sentences[sel.sid].trim(), context: contextAround(S.st.sentences, sel.sid), surface: sel.surface, chapterId: S.chapter.id };
  } else {
    const c = S.full.get(sel.w)?.contexts?.[0];
    if (c) src = { sentence: c.s, context: c.s, surface: sel.w, chapterId: c.ch || null };
  }
  if (!src) return toast("Откройте главу, где встречается это слово, чтобы разобрать его в контексте");
  S.regenOpen = false;
  generateFor(sel.w, src, wish);
}

function generateFor(w, src, wish = "") {
  const key = apiKey();
  if (!key) {
    toast("Сначала добавьте API-ключ Anthropic в настройках");
    openPanel("settings");
    return Promise.resolve(false);
  }
  if (S.gen.has(w)) return S.gen.get(w).promise;
  const job = { thinking: "", started: Date.now(), abort: new AbortController() };
  S.gen.set(w, job);
  S.genErr.delete(w);
  if (isSelected(w) && !S.editing) renderWordView();
  job.promise = (async () => {
    try {
      const res = await generateCard({
        apiKey: key,
        settings: S.settings,
        surface: src.surface,
        sentence: src.sentence,
        context: src.context,
        wish,
        signal: job.abort.signal,
        onThinking: (t) => {
          job.thinking = t;
          patchThinking(w);
        },
      });
      const d = res.data;
      let full = S.full.get(w);
      if (!full && S.words.has(w)) full = await S.db.getWordFull(w).catch(() => null);
      full = full || { word: w, contexts: [], notes: null };
      const contexts = [
        ...(full.contexts || []).filter((c) => c.s !== src.sentence),
        { s: src.sentence, text: d.context, ru: d.sentence_translation, tr: d.translation, ch: src.chapterId },
      ].slice(-12);
      const card = {
        lemma: d.lemma,
        translation: d.translation,
        pos: d.pos,
        pronunciation: d.pronunciation,
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
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          cost: res.cost,
          at: new Date().toISOString(),
          ...(wish ? { wish } : {}),
        },
      };
      const quick = rowOf(w).quick || { translation: d.translation, pronunciation: d.pronunciation, ipa: d.ipa, pos: d.pos, lemma: d.lemma };
      await S.db.saveWord({ word: w, card, contexts, quick });
      S.full.set(w, { ...full, card, contexts, quick });
      S.words.set(w, { ...rowOf(w), quick, has_card: true });
      addSpent(res.cost);
      return true;
    } catch (e) {
      if (e?.name !== "AbortError") S.genErr.set(w, e.message || String(e));
      return false;
    } finally {
      S.gen.delete(w);
      if (isSelected(w) && !S.editing) renderWordView();
      updateChapterStats();
    }
  })();
  return job.promise;
}

function patchThinking(w) {
  if (!isSelected(w)) return;
  const el = $("#gen-thinking");
  const job = S.gen.get(w);
  if (!el || !job) return;
  el.textContent = job.thinking.slice(-1800);
  el.scrollTop = el.scrollHeight;
}

async function explainHere() {
  const sel = S.sel;
  if (!sel || sel.sid == null) return;
  if (!apiKey()) {
    toast("Сначала добавьте API-ключ Anthropic в настройках");
    return openPanel("settings");
  }
  const w = sel.w;
  const sentence = S.st.sentences[sel.sid].trim();
  const base = S.full.get(w)?.card || rowOf(w).quick || {};
  S.ctxJob = { w, sid: sel.sid };
  S.ctxErr = null;
  renderWordView();
  try {
    const res = await explainContext({
      apiKey: apiKey(),
      settings: S.settings,
      surface: sel.surface,
      lemma: base.lemma,
      translation: base.translation,
      sentence,
      context: contextAround(S.st.sentences, sel.sid),
    });
    const fresh = S.full.get(w) || { word: w, contexts: [] };
    const contexts = [
      ...(fresh.contexts || []).filter((c) => c.s !== sentence),
      { s: sentence, text: res.data.context, ru: res.data.sentence_translation, tr: res.data.translation, ch: S.chapter.id },
    ].slice(-12);
    await S.db.saveWord({ word: w, contexts });
    S.full.set(w, { ...fresh, contexts });
    addSpent(res.cost);
  } catch (e) {
    S.ctxErr = e.message || String(e);
  } finally {
    S.ctxJob = null;
    if (isSelected(w) && !S.editing) renderWordView();
  }
}

/* ----- HTML карточки ----- */

function renderWordView() {
  const body = $("#drawer-body");
  if (!body || S.panel.mode !== "word") return;
  const sel = S.sel;
  if (!sel) {
    body.innerHTML = `<p class="pp-note pp-pad">Нажмите на любое слово в тексте.</p>`;
    return;
  }
  const w = sel.w;
  const row = rowOf(w);
  const full = S.full.get(w);
  const keep = S.renderedWord === w ? body.scrollTop : 0;
  if (S.editing) {
    body.innerHTML = editHTML(sel, row, full);
  } else {
    const first = row.first_chapter ? chapterTitle(row.first_chapter) : "";
    body.innerHTML = `<div class="pp-wv">
      <div class="pp-headword" lang="es"><span>${esc(sel.surface)}</span><button class="pp-icon-btn sm" data-act="speak" data-text="${esc(sel.surface)}" title="Произнести" aria-label="Произнести слово">${I.volume}</button></div>
      <div id="wv-quick">${quickHTML(w, row)}</div>
      ${levelsHTML(row)}
      ${dictLinksHTML(w, row, full)}
      ${sentenceHTML(sel, row, full)}
      ${cardHTML(sel, row, full)}
      ${full?.notes ? `<section class="pp-sec"><h3 class="pp-h">Мои заметки</h3><p class="pp-notes">${esc(full.notes)}</p></section>` : ""}
      ${first ? `<p class="pp-note pp-first">Впервые встретилось в главе «${esc(first)}».</p>` : ""}
    </div>`;
  }
  body.scrollTop = keep;
  S.renderedWord = w;
}

function quickHTML(w, row) {
  const q = row.quick;
  if (q && (q.translation || q.pronunciation)) {
    const chips = [
      q.pronunciation && `<span class="pp-chip">[${esc(q.pronunciation)}]</span>`,
      q.ipa && `<span class="pp-chip">/${esc(String(q.ipa).replace(/^\/|\/$/g, ""))}/</span>`,
      q.pos && `<span class="pp-chip">${esc(q.pos)}</span>`,
      q.lemma && q.lemma.toLowerCase() !== w && `<span class="pp-chip">словарная форма <b lang="es">${esc(q.lemma)}</b></span>`,
    ]
      .filter(Boolean)
      .join("");
    return `${q.translation ? `<div class="pp-tr">${esc(q.translation)}</div>` : ""}<div class="pp-chips">${chips}</div>`;
  }
  if (!apiKey())
    return `<p class="pp-note">Перевод и произношение появятся, когда вы добавите API-ключ Anthropic в <button class="pp-link" data-act="panel" data-mode="settings">настройках</button>.</p>`;
  if (S.quickErr.has(w))
    return `<div class="pp-error"><p>Перевод не загрузился: ${esc(S.quickErr.get(w))}</p><button class="pp-soft-btn" data-act="retry-quick">Повторить</button></div>`;
  return `<div class="pp-sk" style="width:46%;height:20px"></div><div class="pp-sk" style="width:72%"></div>`;
}

function levelsHTML(row) {
  return `<div class="pp-levels" role="group" aria-label="Насколько хорошо вы знаете слово">
    ${[5, 4, 3, 2, 1]
      .map(
        (l) =>
          `<button class="pp-level lv${l}${row.level === l ? " on" : ""}" data-act="level" data-level="${l}" aria-pressed="${row.level === l}"><b>${l}</b><span>${LEVEL_LABEL[l]}</span></button>`
      )
      .join("")}
  </div>
  <p class="pp-hint">Клавиши 1–5 ставят уровень, стрелки ← → переходят к соседнему слову.</p>`;
}

function dictLinksHTML(w, row, full) {
  const lemma = String(row.quick?.lemma || full?.card?.lemma || w).toLowerCase();
  const e = encodeURIComponent;
  return `<div class="pp-dicts" aria-label="Внешние словари">
    <a href="https://dle.rae.es/${e(lemma)}" target="_blank" rel="noopener noreferrer">RAE ${I.link}</a>
    <a href="https://ru.wiktionary.org/wiki/${e(lemma)}" target="_blank" rel="noopener noreferrer">Викисловарь ${I.link}</a>
    <a href="https://context.reverso.net/translation/spanish-russian/${e(w)}" target="_blank" rel="noopener noreferrer">Reverso ${I.link}</a>
    <a href="https://forvo.com/word/${e(w)}/#es" target="_blank" rel="noopener noreferrer">Forvo ${I.link}</a>
  </div>`;
}

function sentenceHTML(sel, row, full) {
  const w = sel.w;
  if (sel.sid == null) {
    const list = full?.contexts || [];
    if (!list.length) return "";
    return `<section class="pp-sec"><h3 class="pp-h">Где встречалось</h3>${list
      .map(
        (c) =>
          `<div class="pp-ctx-item"><p class="pp-sent" lang="es">${esc(c.s)}</p>${c.ru ? `<p class="pp-sent-ru">${esc(c.ru)}</p>` : ""}${c.text ? `<p>${esc(c.text)}</p>` : ""}</div>`
      )
      .join("")}</section>`;
  }
  const sentence = S.st.sentences[sel.sid].trim();
  const tokens = S.st.sentTokens[sel.sid];
  const occ = S.st.occ.get(w) || [];
  const pos = occ.findIndex(([s, t]) => s === sel.sid && t === sel.ti);
  const here = (full?.contexts || []).find((c) => c.s === sentence);
  const sentInner = tokens
    .map((t, ti) =>
      t.w
        ? `<span class="pp-wd l${rowOf(t.w).level}${t.w === w ? (ti === sel.ti ? " is-cur" : " is-same") : ""}" data-w="${esc(t.w)}" data-s="${sel.sid}" data-i="${ti}">${esc(t.t)}</span>`
        : esc(t.t)
    )
    .join("");
  let why;
  if (here?.text) {
    const qt = String(row.quick?.translation || "").toLowerCase();
    const showTr = here.tr && qt && !qt.includes(String(here.tr).toLowerCase());
    why = `<p>${esc(here.text)}${showTr ? ` <span class="pp-here-tr">Здесь: «${esc(here.tr)}».</span>` : ""}</p>`;
  } else if (S.gen.has(w)) why = `<p class="pp-note">Объяснение появится вместе с разбором слова.</p>`;
  else if (S.ctxJob?.w === w) why = skel(2);
  else if (row.has_card || full?.card)
    why = `${S.ctxErr ? `<p class="pp-error-line">${esc(S.ctxErr)}</p>` : ""}<button class="pp-soft-btn" data-act="explain-here">${I.sparkles} Объяснить это место</button>`;
  else why = `<p class="pp-note">Появится после разбора слова.</p>`;

  return `<section class="pp-sec">
    <div class="pp-sec-h"><h3 class="pp-h">В этом месте истории</h3>${
      occ.length > 1
        ? `<span class="pp-occ"><button data-act="occ" data-dir="-1" aria-label="Предыдущее место в тексте">${I.left}</button>${pos + 1} из ${occ.length}<button data-act="occ" data-dir="1" aria-label="Следующее место в тексте">${I.right}</button></span>`
        : ""
    }</div>
    <div class="pp-sent-wrap">
      <p class="pp-sent hl-${esc(S.settings.highlight)}" data-hl lang="es">${sentInner}</p>
      <button class="pp-icon-btn sm pp-sent-say" data-act="speak" data-text="${esc(sentence)}" title="Прочитать вслух" aria-label="Прочитать предложение вслух">${I.volume}</button>
    </div>
    ${here?.ru ? `<p class="pp-sent-ru">${esc(here.ru)}</p>` : ""}
    <h3 class="pp-h pp-h-gap">Почему здесь это слово</h3>
    ${why}
  </section>`;
}

function effortText(modelId, effort) {
  const info = modelInfo(modelId);
  return info.efforts && effort ? `, размышление ${EFFORTS[effort] || effort}` : "";
}

function cardHTML(sel, row, full) {
  const w = sel.w;
  const job = S.gen.get(w);
  const card = full?.card;
  const info = modelInfo(S.settings.cardModel);
  if (job) {
    const showThinking = S.settings.showThinking && (info.thinking === "adaptive" || info.thinking === "always");
    return `<section class="pp-sec pp-gen">
      <div class="pp-gen-h"><span class="pp-spin">${I.loader}</span><span>Claude разбирает слово: ${esc(info.name)}${esc(effortText(info.id, S.settings.cardEffort))}. Прошло <span id="gen-elapsed">${Math.round((Date.now() - job.started) / 1000)} с</span>.</span></div>
      ${showThinking ? `<div class="pp-thinking" id="gen-thinking" aria-live="polite">${esc(job.thinking.slice(-1800)) || "Модель думает. Краткий ход рассуждений появится здесь."}</div>` : ""}
      ${skel(4)}
      <button class="pp-soft-btn" data-act="gen-cancel">Отменить разбор</button>
    </section>`;
  }
  if (row.has_card && !full) return `<section class="pp-sec">${skel(5)}</section>`;
  if (!card) {
    const est = estimateCardCost(S.settings.cardModel, S.settings.cardEffort);
    return `<section class="pp-sec pp-cta">
      ${S.genErr.has(w) ? `<div class="pp-error"><p>Разбор не получился: ${esc(S.genErr.get(w))}</p></div>` : ""}
      <button class="pp-primary" data-act="gen-card">${I.sparkles} Разобрать слово с Claude</button>
      <p class="pp-note">${esc(info.name)}${esc(effortText(info.id, S.settings.cardEffort))}.${info.custom ? "" : ` Примерная цена одного разбора: около ${money(est)}.`}</p>
      <button class="pp-link" data-act="edit">Заполнить карточку вручную</button>
    </section>`;
  }
  const fm = FACT_META[String(card.fact_type || "").toLowerCase()] || ["💡", "Интересный факт", "wow"];
  const meta = card.meta || {};
  const metaLine = meta.manual
    ? "Карточка заполнена вручную."
    : meta.model
      ? `Разобрано моделью ${esc(modelInfo(meta.model).name)}${esc(effortText(meta.model, meta.effort))}. Токенов: ${fmtInt((meta.input_tokens || 0) + (meta.output_tokens || 0))}, стоимость около ${money(meta.cost || 0)}.`
      : "";
  const sec = (title, text) => (text ? `<section class="pp-sec"><h3 class="pp-h">${title}</h3><p>${esc(text)}</p></section>` : "");
  const qt = String(row.quick?.translation || "").toLowerCase();
  return `
    ${card.translation && qt && !qt.includes(String(card.translation).toLowerCase()) ? `<p class="pp-note pp-card-tr">В разборе переведено как <b>${esc(card.translation)}</b>.</p>` : ""}
    ${sec("Происхождение", card.etymology)}
    ${sec("История слова", card.history)}
    ${card.fact ? `<section class="pp-sec"><div class="pp-fact" data-k="${fm[2]}"><div class="pp-fact-h"><span class="pp-fact-emoji" aria-hidden="true">${fm[0]}</span>${fm[1]}</div><p>${esc(card.fact)}</p></div></section>` : ""}
    ${card.relatives?.length ? `<section class="pp-sec"><h3 class="pp-h">Родственные слова</h3><div class="pp-chips">${card.relatives.map((r) => `<span class="pp-chip">${esc(r)}</span>`).join("")}</div></section>` : ""}
    ${card.mnemonic ? `<section class="pp-sec"><div class="pp-mn">${I.bulb}<div><h3 class="pp-h">Как запомнить</h3><p>${esc(card.mnemonic)}</p></div></div></section>` : ""}
    <section class="pp-sec pp-card-foot">
      ${S.genErr.has(w) ? `<div class="pp-error"><p>Перегенерация не получилась: ${esc(S.genErr.get(w))}</p></div>` : ""}
      ${
        S.regenOpen
          ? `<label class="pp-label" for="regen-wish">Что изменить в новом разборе (необязательно)</label>
             <textarea class="pp-input" id="regen-wish" rows="2" placeholder="Например: сделай факт жутче или добавь пример из песни"></textarea>
             <div class="pp-row"><button class="pp-primary" data-act="regen-go">${I.sparkles} Перегенерировать</button><button class="pp-soft-btn" data-act="regen-close">Отмена</button></div>
             <p class="pp-note">Новый разбор заменит текст карточки, включая ваши правки. Заметки и уровень останутся.</p>`
          : `<div class="pp-row"><button class="pp-soft-btn" data-act="edit">${I.edit} Редактировать</button><button class="pp-soft-btn" data-act="regen-open">${I.sparkles} Перегенерировать</button></div>`
      }
      ${metaLine ? `<p class="pp-note">${metaLine}</p>` : ""}
      <p class="pp-note">Разбор написан ИИ. Этимологию и факты полезно сверять со словарями.</p>
    </section>`;
}

function editHTML(sel, row, full) {
  const q = row.quick || {};
  const c = full?.card || {};
  const attached = sel.sid != null;
  const sentence = attached ? S.st.sentences[sel.sid].trim() : "";
  const here = attached ? (full?.contexts || []).find((x) => x.s === sentence) || {} : null;
  const field = (id, label, value, rows = 0, extra = "") =>
    `<label class="pp-label" for="${id}">${label}</label>${
      rows
        ? `<textarea class="pp-input" id="${id}" rows="${rows}" ${extra}>${esc(value || "")}</textarea>`
        : `<input class="pp-input" id="${id}" value="${esc(value || "")}" ${extra}>`
    }`;
  return `<div class="pp-wv pp-edit">
    <div class="pp-headword" lang="es"><span>${esc(sel.surface)}</span></div>
    <p class="pp-note">Меняйте любые поля. Пустые поля в карточке не показываются.</p>
    <fieldset class="pp-fieldset"><legend>Словарь</legend>
      ${field("e-q-translation", "Перевод", q.translation)}
      ${field("e-q-pronunciation", "Произношение русскими буквами", q.pronunciation)}
      ${field("e-q-ipa", "Транскрипция МФА", q.ipa)}
      ${field("e-q-pos", "Часть речи и форма", q.pos)}
      ${field("e-q-lemma", "Словарная форма", q.lemma, 0, 'lang="es"')}
    </fieldset>
    ${
      attached
        ? `<fieldset class="pp-fieldset"><legend>В этом месте истории</legend>
      <p class="pp-sent" lang="es">${esc(sentence)}</p>
      ${field("e-h-ru", "Перевод предложения", here.ru, 2)}
      ${field("e-h-tr", "Перевод слова в этом месте", here.tr)}
      ${field("e-h-text", "Почему здесь это слово", here.text, 3)}
    </fieldset>`
        : ""
    }
    <fieldset class="pp-fieldset"><legend>Разбор</legend>
      ${field("e-c-translation", "Перевод в разборе", c.translation)}
      ${field("e-c-etymology", "Происхождение", c.etymology, 3)}
      ${field("e-c-history", "История слова", c.history, 4)}
      <label class="pp-label" for="e-c-fact_type">Какой это факт</label>
      <select class="pp-input" id="e-c-fact_type">${FACT_TYPES.map(
        (t) => `<option value="${t}"${String(c.fact_type || "").toLowerCase() === t ? " selected" : ""}>${t}</option>`
      ).join("")}</select>
      ${field("e-c-fact", "Факт", c.fact, 3)}
      ${field("e-c-relatives", "Родственные слова, по одному в строке", (c.relatives || []).join("\n"), 3)}
      ${field("e-c-mnemonic", "Как запомнить", c.mnemonic, 2)}
    </fieldset>
    <fieldset class="pp-fieldset"><legend>Мои заметки</legend>
      ${field("e-notes", "Заметки к слову", full?.notes, 3)}
    </fieldset>
    <div class="pp-row pp-edit-actions"><button class="pp-primary" data-act="edit-save">Сохранить</button><button class="pp-soft-btn" data-act="edit-cancel">Отмена</button></div>
  </div>`;
}

async function saveEdit() {
  const sel = S.sel;
  if (!sel) return;
  const w = sel.w;
  const row = rowOf(w);
  const full = S.full.get(w) || { word: w, contexts: [], card: null, notes: null };
  const v = (id) => ($(`#${id}`)?.value ?? "").trim();

  const quickRaw = { translation: v("e-q-translation"), pronunciation: v("e-q-pronunciation"), ipa: v("e-q-ipa"), pos: v("e-q-pos"), lemma: v("e-q-lemma") };
  const quick = Object.values(quickRaw).some(Boolean) ? quickRaw : null;

  const fields = {
    translation: v("e-c-translation"),
    etymology: v("e-c-etymology"),
    history: v("e-c-history"),
    fact_type: v("e-c-fact_type"),
    fact: v("e-c-fact"),
    relatives: v("e-c-relatives").split("\n").map((s) => s.trim()).filter(Boolean),
    mnemonic: v("e-c-mnemonic"),
  };
  const hasText = ["translation", "etymology", "history", "fact", "mnemonic"].some((k) => fields[k]) || fields.relatives.length > 0;
  const shared = { lemma: quickRaw.lemma, pos: quickRaw.pos, pronunciation: quickRaw.pronunciation, ipa: quickRaw.ipa };
  let card = null;
  if (hasText) card = full.card ? { ...full.card, ...shared, ...fields } : { ...shared, ...fields, meta: { manual: true, at: new Date().toISOString() } };

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
    btn.textContent = "Сохраняю…";
  }
  try {
    await S.db.saveWord({ word: w, quick, card, contexts, notes });
    S.full.set(w, { ...full, quick, card, contexts, notes });
    S.words.set(w, { ...row, quick, has_card: !!card });
    S.editing = false;
    renderWordView();
    updateChapterStats();
    toast("Изменения сохранены");
  } catch (e) {
    toast(`Не сохранилось: ${e.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Сохранить";
    }
  }
}

/* ---------------- Словарь главы и массовый разбор ---------------- */

async function prepareDictionary(manual = false) {
  if (!S.st || !S.chapter) return;
  if (!apiKey()) {
    if (manual) toast("Сначала добавьте API-ключ Anthropic в настройках");
    return;
  }
  if (S.dict.running) return;
  const missing = [...S.st.firstOcc.entries()]
    .filter(([w]) => !rowOf(w).quick)
    .map(([w, o]) => ({ word: w, sentence: S.st.sentences[o.sid].trim().slice(0, 160) }));
  if (!missing.length) {
    if (manual) toast("Словарь этой главы уже готов");
    return;
  }
  const token = {};
  S.dict = { running: true, done: 0, total: missing.length, token };
  updateTopProgress();
  updateChapterStats();
  let failed = null;
  for (let i = 0; i < missing.length; i += DICT_BATCH) {
    if (S.dict.token !== token) return;
    const batch = missing.slice(i, i + DICT_BATCH).filter((it) => !rowOf(it.word).quick);
    if (batch.length) {
      try {
        const res = await lookupWords({ apiKey: apiKey(), model: S.settings.dictModel, items: batch });
        const rows = batch.filter((it) => res.map.has(it.word)).map((it) => ({ word: it.word, quick: res.map.get(it.word) }));
        await S.db.saveWords(rows);
        for (const r of rows) {
          S.words.set(r.word, { ...rowOf(r.word), quick: r.quick });
          const f = S.full.get(r.word);
          if (f) f.quick = r.quick;
        }
        addSpent(res.cost);
        if (S.sel && rows.some((r) => r.word === S.sel.w)) patchQuick(S.sel.w);
      } catch (e) {
        failed = e;
        break;
      }
    }
    if (S.dict.token !== token) return;
    S.dict.done = Math.min(S.dict.total, i + DICT_BATCH);
    updateTopProgress();
  }
  if (S.dict.token !== token) return;
  S.dict = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  if (failed) toast(`Словарь остановился: ${failed.message}`);
}

function stopDictionary(silent = false) {
  if (!S.dict.running) return;
  S.dict = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  if (!silent) toast("Подготовка словаря остановлена");
}

async function bulkAnalyze() {
  if (!S.st) return;
  if (!apiKey()) {
    toast("Сначала добавьте API-ключ Anthropic в настройках");
    return openPanel("settings");
  }
  const todo = [...S.st.firstOcc.entries()].filter(([w]) => rowOf(w).level > 1 && !rowOf(w).has_card);
  if (!todo.length) return toast("Все неизученные слова этой главы уже разобраны");
  const info = modelInfo(S.settings.cardModel);
  const est = estimateCardCost(S.settings.cardModel, S.settings.cardEffort) * todo.length;
  const ok = confirm(
    `Разобрать ${todo.length} ${plural(todo.length, "слово", "слова", "слов")} моделью ${info.name}${effortText(info.id, S.settings.cardEffort)}?\n` +
      (info.custom ? "" : `Очень грубая оценка стоимости: около ${money(est)}.\n`) +
      "Слова с уровнем 1 пропускаются. Остановить можно в любой момент."
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
      if (!rowOf(w).has_card && rowOf(w).level > 1) {
        const done = await generateFor(w, {
          sentence: st.sentences[o.sid].trim(),
          context: contextAround(st.sentences, o.sid),
          surface: o.surface,
          chapterId,
        });
        if (!done) {
          failures++;
          lastError = S.genErr.get(w) || lastError;
          if (failures >= 3 && S.bulk.token === token) {
            S.bulk = { running: false, done: 0, total: 0, token: null };
            toast(`Разбор остановлен после нескольких ошибок: ${lastError}`, 7000);
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
    toast(failures ? `Разбор закончен, ошибок: ${failures}` : "Все неизученные слова главы разобраны");
  }
  updateTopProgress();
  updateChapterStats();
}

function stopBulk() {
  S.bulk = { running: false, done: 0, total: 0, token: null };
  updateTopProgress();
  updateChapterStats();
  toast("Разбор остановлен. Слова, которые уже в работе, досчитаются.");
}

/* ---------------- Мой словарь ---------------- */

function renderVocab() {
  const body = $("#drawer-body");
  body.innerHTML = `<div class="pp-vocab">
    <label class="pp-search"><input data-role="vocab-search" value="${esc(S.vocab.q)}" placeholder="Поиск по словам и переводам" aria-label="Поиск по словарю"></label>
    <div class="pp-filter" role="group" aria-label="Фильтр по уровню">
      ${[[0, "Все уровни"], [5, "5"], [4, "4"], [3, "3"], [2, "2"], [1, "1"]]
        .map(([l, t]) => `<button class="pp-chip-btn lv${l}${S.vocab.level === l ? " on" : ""}" data-act="vocab-level" data-level="${l}">${t}</button>`)
        .join("")}
    </div>
    <div id="vocab-list"></div>
  </div>`;
  renderVocabList();
}

function renderVocabList() {
  const box = $("#vocab-list");
  if (!box) return;
  const q = S.vocab.q.trim().toLowerCase();
  let rows = [...S.words.values()];
  if (S.vocab.level) rows = rows.filter((r) => r.level === S.vocab.level);
  if (q) rows = rows.filter((r) => r.word.includes(q) || String(r.quick?.translation || "").toLowerCase().includes(q));
  rows.sort((a, b) => a.word.localeCompare(b.word, "es"));
  box.innerHTML = `<p class="pp-note">${rows.length ? `Слов: ${fmtInt(rows.length)}` : S.words.size ? "Ничего не найдено." : "Словарь пока пуст. Добавьте главу."}</p>
    <ul class="pp-vlist">${rows
      .slice(0, 600)
      .map(
        (r) =>
          `<li><button data-act="open-word" data-w="${esc(r.word)}"><span class="pp-dot lv${r.level}" title="Уровень ${r.level}"></span><span class="pp-v-word" lang="es">${esc(r.word)}</span><span class="pp-v-tr">${esc(r.quick?.translation || "")}</span></button></li>`
      )
      .join("")}</ul>
    ${rows.length > 600 ? `<p class="pp-note">Показаны первые 600 слов. Уточните поиск.</p>` : ""}`;
}

/* ---------------- Прогресс ---------------- */

function renderProgress() {
  const body = $("#drawer-body");
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let cards = 0;
  let week = 0;
  const weekAgo = Date.now() - 7 * 864e5;
  for (const r of S.words.values()) {
    c[r.level]++;
    if (r.has_card) cards++;
    if (r.level === 1 && r.learned_at && Date.parse(r.learned_at) > weekAgo) week++;
  }
  const total = S.words.size;
  body.innerHTML = `
    <section class="pp-sec pp-sec-first">
      <h3 class="pp-h">Все слова</h3>
      <p class="pp-big">Выучено <b>${fmtInt(c[1])}</b> из <b>${fmtInt(total)}</b></p>
      ${[5, 4, 3, 2, 1]
        .map(
          (l) => `<div class="pp-prog-row"><span class="pp-dot lv${l}"></span><span class="pp-prog-label">${l}, ${LEVEL_LABEL[l]}</span>
          <span class="pp-prog-bar"><i class="lb${l}" style="width:${total ? (c[l] / total) * 100 : 0}%"></i></span><b>${fmtInt(c[l])}</b></div>`
        )
        .join("")}
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">Работа</h3>
      <p>За последние 7 дней выучено: <b>${fmtInt(week)}</b>.</p>
      <p>Подробных разборов: <b>${fmtInt(cards)}</b>.</p>
      <p>Потрачено на Claude API примерно: <b>${money(S.settings.spent || 0)}</b>. <button class="pp-link" data-act="reset-spent">Обнулить</button></p>
    </section>
    <section class="pp-sec">
      <h3 class="pp-h">Главы</h3>
      <div id="prog-chapters">${chaptersProgressHTML()}</div>
    </section>`;
  loadChapterWords();
}

function chaptersProgressHTML() {
  if (!S.chapters.length) return `<p class="pp-note">Глав пока нет.</p>`;
  return S.chapters
    .map((ch) => {
      const set = S.chapterWords.get(ch.id);
      if (!set) return `<div class="pp-prog-ch"><span>${esc(ch.title)}</span><span class="pp-note">считаю…</span></div>`;
      const c = levelCounts(set);
      const pct = set.size ? Math.round((c[1] / set.size) * 100) : 0;
      return `<div class="pp-prog-ch"><div class="pp-prog-ch-h"><span>${esc(ch.title)}</span><b>${pct}%</b></div><div class="pp-levelbar">${levelBarHTML(c)}</div></div>`;
    })
    .join("");
}

async function loadChapterWords() {
  for (const ch of S.chapters) {
    if (S.chapterWords.has(ch.id)) continue;
    try {
      const full = await S.db.getChapter(ch.id);
      S.chapterWords.set(ch.id, new Set(buildStructure(full.paragraphs).firstOcc.keys()));
    } catch {
      S.chapterWords.set(ch.id, new Set());
    }
    if (S.panel.open && S.panel.mode === "progress" && $("#prog-chapters")) $("#prog-chapters").innerHTML = chaptersProgressHTML();
  }
}

/* ---------------- Настройки ---------------- */

function modelOptions(selected) {
  const known = MODELS.some((m) => m.id === selected);
  return (
    MODELS.map(
      (m) => `<option value="${m.id}"${m.id === selected ? " selected" : ""}>${m.name} — $${m.inPrice} / $${m.outPrice} за млн токенов, ${m.note}</option>`
    ).join("") +
    (known ? "" : `<option value="${esc(selected)}" selected>${esc(selected)}</option>`) +
    `<option value="__custom">Другая модель: ввести ID…</option>`
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
      .map(([v, l]) => `<button role="radio" aria-checked="${s[k] === v}" class="${s[k] === v ? "on" : ""}" data-act="seg" data-key="${k}" data-val="${v}">${l}</button>`)
      .join("")}</div>`;
  const est = estimateCardCost(s.cardModel, s.cardEffort);
  body.innerHTML = `
    <section class="pp-sec pp-sec-first">
      <h3 class="pp-h">Ключ Claude API</h3>
      <p class="pp-note">Ключ хранится только в этом браузере и уходит напрямую в Anthropic. На другом устройстве его нужно ввести снова. Оплата API идёт отдельно от подписки claude.ai.</p>
      <input class="pp-input" id="api-key" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${key ? `••••••••${esc(key.slice(-4))}` : ""}">
      <div class="pp-row pp-mt">
        <button class="pp-primary" data-act="save-key">Сохранить ключ</button>
        ${key ? `<button class="pp-soft-btn" data-act="check-key">Проверить</button><button class="pp-soft-btn" data-act="clear-key">Удалить</button>` : ""}
      </div>
      <p class="pp-note pp-mt" id="key-status">${key ? "Ключ сохранён." : "Ключа нет, поэтому перевод и разбор слов недоступны."}</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Подробный разбор слова</h3>
      <label class="pp-label" for="set-card-model">Модель</label>
      <select class="pp-input" id="set-card-model" data-set="cardModel">${modelOptions(s.cardModel)}</select>
      ${
        cm.efforts
          ? `<label class="pp-label" for="set-effort">Глубина размышления</label>
             <select class="pp-input" id="set-effort" data-set="cardEffort">${cm.efforts
               .map((e) => `<option value="${e}"${s.cardEffort === e ? " selected" : ""}>${EFFORTS[e][0].toUpperCase() + EFFORTS[e].slice(1)}</option>`)
               .join("")}</select>
             <p class="pp-note">«Максимальное» думает дольше всех и стоит дороже. Для одного слова обычно хватает высокого.</p>
             <label class="pp-check"><input type="checkbox" data-set="showThinking"${s.showThinking ? " checked" : ""}> Показывать краткий ход размышлений во время разбора</label>`
          : cm.thinking === "manual"
            ? `<label class="pp-check"><input type="checkbox" data-set="haikuThinking"${s.haikuThinking ? " checked" : ""}> Включить размышление перед ответом</label>`
            : ""
      }
      <label class="pp-check"><input type="checkbox" data-set="autoCard"${s.autoCard ? " checked" : ""}> Разбирать слово сразу при нажатии, без кнопки</label>
      ${cm.custom ? "" : `<p class="pp-note">Один разбор с этими настройками стоит примерно ${money(est)}. Точная цена видна в каждой карточке.</p>`}
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Быстрый словарь</h3>
      <p class="pp-note">Перевод и произношение, которые появляются сразу при нажатии на слово.</p>
      <label class="pp-label" for="set-dict-model">Модель для словаря</label>
      <select class="pp-input" id="set-dict-model" data-set="dictModel">${modelOptions(s.dictModel)}</select>
      <label class="pp-check"><input type="checkbox" data-set="autoDict"${s.autoDict ? " checked" : ""}> Готовить словарь для всей главы при её открытии</label>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Чтение</h3>
      <div class="pp-sec-h"><label class="pp-label" for="set-size">Размер текста</label><span class="pp-note" id="size-out">${s.size} px</span></div>
      <input type="range" id="set-size" min="16" max="30" step="1" value="${s.size}" data-set="size" class="pp-range">
      <p class="pp-label">Тема</p>
      ${seg("theme", [["light", "Светлая"], ["dark", "Тёмная"]])}
      <p class="pp-label">Подсветка слов</p>
      ${seg("highlight", [["all", "Все слова"], ["unlearned", "Неизученные"], ["none", "Выключить"]])}
      <p class="pp-note pp-mt">Чем ярче слово, тем хуже вы его знаете. Уровень 5 горит сильнее всего, уровень 1 не подсвечивается.</p>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Главы</h3>
      ${
        S.chapters.length
          ? S.chapters
              .map(
                (c) => `<div class="pp-ch-row"><span>${esc(c.title)}${S.chapter?.id === c.id ? ` <em>открыта</em>` : ""}</span>
                <span class="pp-row"><button class="pp-icon-btn sm" data-act="rename-chapter" data-id="${esc(c.id)}" title="Переименовать" aria-label="Переименовать главу">${I.edit}</button>
                <button class="pp-icon-btn sm" data-act="delete-chapter" data-id="${esc(c.id)}" title="Удалить" aria-label="Удалить главу">${I.trash}</button></span></div>`
              )
              .join("")
          : `<p class="pp-note">Глав пока нет.</p>`
      }
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Резервная копия</h3>
      <p class="pp-note">Бесплатный Supabase не делает резервных копий. Иногда скачивайте файл со всеми главами, словами и карточками.</p>
      <div class="pp-row"><button class="pp-soft-btn" data-act="export">Скачать копию</button><button class="pp-soft-btn" data-act="import">Загрузить копию</button></div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </section>

    <section class="pp-sec">
      <h3 class="pp-h">Аккаунт</h3>
      <p>${esc(S.email || "Вы вошли")}</p>
      <button class="pp-soft-btn pp-mt" data-act="logout">Выйти</button>
    </section>`;
}

function saveKey() {
  const input = $("#api-key");
  const v = (input?.value || "").trim();
  if (!v || v.startsWith("••••")) return toast("Вставьте ключ целиком");
  if (!v.startsWith("sk-ant-") && !confirm("Ключ Anthropic обычно начинается с sk-ant-. Всё равно сохранить?")) return;
  localStorage.setItem(LS.api, v);
  renderSettings();
  toast("Ключ сохранён в этом браузере");
  updateChapterStats();
  if (S.st && S.settings.autoDict) prepareDictionary();
}

async function checkKeyAction() {
  const st = $("#key-status");
  if (st) st.textContent = "Проверяю ключ…";
  try {
    await checkKey(apiKey());
    if (st) st.textContent = "Ключ работает.";
  } catch (e) {
    if (st) st.textContent = e.message;
  }
}

async function exportBackup() {
  try {
    toast("Готовлю резервную копию…");
    const data = await S.db.exportAll();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `palabra-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Копия скачана");
  } catch (e) {
    toast(`Копия не создалась: ${e.message}`);
  }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "palabra-por-palabra") throw new Error("это не файл копии Palabra por palabra");
    const ok = confirm(
      `Загрузить копию от ${String(data.exported_at || "").slice(0, 10)}? Глав: ${data.chapters?.length || 0}, слов: ${data.words?.length || 0}. Совпадающие главы и слова заменятся данными из файла.`
    );
    if (!ok) return;
    toast("Загружаю копию…", 10000);
    await S.db.importAll(data);
    toast("Копия загружена, обновляю страницу");
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    toast(`Копия не загрузилась: ${e.message}`);
  }
}

if (!window.__PPP_TEST__) boot();
