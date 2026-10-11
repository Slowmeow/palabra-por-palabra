// Firebase: email sign-in and the Cloud Firestore database.
// The SDK is loaded from Google's CDN at a fixed version; if that fails, from esm.sh.
//
// Layout (everything lives under users/{uid}, see firestore.rules):
//   meta/settings          { data }
//   meta/chapters          { list: [{ id, title, lang, position, created_at }] }   — the chapter index
//   chapters/{id}          { title, lang, paragraphs, position, created_at }
//   vocab/{lang}~{nn}      { lang, w: { [word]: JSON of the light row } }         — 32 buckets per language
//   cards/{lang}|{word}    { lang, word, card, contexts, notes }                    — loaded when a word opens
//
// Words are packed into buckets so that opening the site costs a few dozen reads, not one per word:
// the free Spark plan allows 50,000 reads and 20,000 writes a day.

const VERSION = "12.19.0";
const SOURCES = [
  (m) => `https://www.gstatic.com/firebasejs/${VERSION}/firebase-${m}.js`,
  (m) => `https://esm.sh/firebase@${VERSION}/${m}`,
];

async function loadSdk() {
  let lastError;
  for (const url of SOURCES) {
    try {
      const [app, auth, fs] = await Promise.all(["app", "auth", "firestore"].map((m) => import(url(m))));
      return { app, auth, fs };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
const SDK = await loadSdk();

const BUCKETS = 32;
const BATCH_LIMIT = 400;
const LIGHT_FIELDS = ["level", "quick", "has_card", "first_chapter", "learned_at", "srs"];
const FULL_FIELDS = ["card", "contexts", "notes"];

const blank = () => ({ level: 5, quick: null, has_card: false, first_chapter: null, learned_at: null, srs: null });

// FNV-1a: spreads words evenly over the buckets.
function bucketOf(word) {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return String((h >>> 0) % BUCKETS).padStart(2, "0");
}

// Turns Firebase errors into messages the app can show and recognise.
function friendly(e) {
  const code = String(e?.code || "");
  const err = new Error(e?.message || String(e));
  err.code = code;
  if (/invalid-credential|wrong-password|user-not-found|invalid-email|invalid-login/.test(code)) err.message = "invalid login";
  return err;
}

export function makeDb(config) {
  const { app: A, auth: Au, fs: F } = SDK;
  const app = A.getApps().length ? A.getApp() : A.initializeApp(config);
  const auth = Au.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch {
    db = F.getFirestore(app);
  }

  let uid = null;
  const light = new Map(); // "lang\tword" -> light row, the db layer's copy for merging partial saves
  let chapterIndex = null;

  const k = (lang, word) => `${lang}\t${word}`;
  const userDoc = (...path) => F.doc(db, "users", uid, ...path);
  const userCol = (name) => F.collection(db, "users", uid, name);
  const bucketRef = (lang, word) => userDoc("vocab", `${lang}~${bucketOf(word)}`);
  const cardRef = (lang, word) => userDoc("cards", `${lang}|${word}`);
  const indexRef = () => userDoc("meta", "chapters");

  const call = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw friendly(e);
    }
  };

  // Splits many writes into batches Firestore accepts.
  async function commitAll(ops) {
    for (let i = 0; i < ops.length; i += BATCH_LIMIT) {
      const batch = F.writeBatch(db);
      for (const op of ops.slice(i, i + BATCH_LIMIT)) op(batch);
      await batch.commit();
    }
  }

  // One write per bucket for any number of words in it.
  function bucketOps(rows) {
    const groups = new Map();
    for (const r of rows) {
      const id = `${r.lang}~${bucketOf(r.word)}`;
      if (!groups.has(id)) groups.set(id, { lang: r.lang, w: {} });
      groups.get(id).w[r.word] = JSON.stringify(r.row);
    }
    return [...groups].map(([id, data]) => (b) => b.set(userDoc("vocab", id), data, { merge: true }));
  }

  async function loadIndex() {
    if (chapterIndex) return chapterIndex;
    const snap = await F.getDoc(indexRef());
    chapterIndex = snap.exists() ? snap.data().list || [] : [];
    return chapterIndex;
  }
  const sortChapters = (list) =>
    [...list].sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.created_at).localeCompare(String(b.created_at)));

  const api = {
    async session() {
      await auth.authStateReady();
      uid = auth.currentUser?.uid || null;
      return auth.currentUser;
    },
    userEmail: async () => auth.currentUser?.email || "",
    signIn: (email, password) =>
      call(async () => {
        const cred = await Au.signInWithEmailAndPassword(auth, email, password);
        uid = cred.user.uid;
        return cred.user;
      }),
    // A popup, not a redirect: redirects break on GitHub Pages because the auth domain is a different site.
    signInWithGoogle: () =>
      call(async () => {
        const provider = new Au.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        const cred = await Au.signInWithPopup(auth, provider);
        uid = cred.user.uid;
        return cred.user;
      }),
    async signOut() {
      await Au.signOut(auth);
      uid = null;
      light.clear();
      chapterIndex = null;
    },

    /* Chapters */
    listChapters: () => call(async () => sortChapters(await loadIndex())),
    getChapter: (id) =>
      call(async () => {
        const snap = await F.getDoc(userDoc("chapters", id));
        if (!snap.exists()) throw new Error("chapter not found");
        const d = snap.data();
        return { id, title: d.title, lang: d.lang, paragraphs: d.paragraphs };
      }),
    addChapter: (title, paragraphs, position, lang) =>
      call(async () => {
        const list = await loadIndex();
        const id = F.doc(userCol("chapters")).id;
        const meta = { id, title, lang, position, created_at: new Date().toISOString() };
        const next = [...list, meta];
        await commitAll([
          (b) => b.set(userDoc("chapters", id), { title, lang, paragraphs, position, created_at: meta.created_at }),
          (b) => b.set(indexRef(), { list: next }),
        ]);
        chapterIndex = next;
        return meta;
      }),
    renameChapter: (id, title) =>
      call(async () => {
        const next = (await loadIndex()).map((c) => (c.id === id ? { ...c, title } : c));
        await commitAll([
          (b) => b.set(userDoc("chapters", id), { title }, { merge: true }),
          (b) => b.set(indexRef(), { list: next }),
        ]);
        chapterIndex = next;
      }),
    deleteChapter: (id) =>
      call(async () => {
        const next = (await loadIndex()).filter((c) => c.id !== id);
        await commitAll([(b) => b.delete(userDoc("chapters", id)), (b) => b.set(indexRef(), { list: next })]);
        chapterIndex = next;
      }),

    /* Words */
    loadWords: () =>
      call(async () => {
        const snap = await F.getDocs(userCol("vocab"));
        light.clear();
        const out = [];
        snap.forEach((d) => {
          const { lang, w } = d.data();
          for (const [word, json] of Object.entries(w || {})) {
            let row;
            try {
              row = { ...blank(), ...JSON.parse(json) };
            } catch {
              continue;
            }
            light.set(k(lang, word), row);
            out.push({ word, lang, ...row });
          }
        });
        return out;
      }),
    getWordFull: (word, lang) =>
      call(async () => {
        const snap = await F.getDoc(cardRef(lang, word));
        const row = light.get(k(lang, word));
        if (!snap.exists() && !row) return null;
        const d = snap.exists() ? snap.data() : {};
        return { word, lang, ...(row || blank()), card: d.card ?? null, contexts: d.contexts || [], notes: d.notes ?? null };
      }),
    // Saves only the given fields of a word and leaves the rest alone.
    saveWord: (fields) =>
      call(async () => {
        const { word, lang } = fields;
        const row = { ...(light.get(k(lang, word)) || blank()) };
        for (const f of LIGHT_FIELDS) if (f in fields) row[f] = fields[f] ?? null;
        if ("card" in fields) row.has_card = !!fields.card;
        const full = {};
        for (const f of FULL_FIELDS) if (f in fields) full[f] = fields[f] ?? (f === "contexts" ? [] : null);
        const ops = bucketOps([{ word, lang, row }]);
        if (Object.keys(full).length) {
          // mergeFields replaces card/contexts/notes whole instead of mixing old and new keys.
          ops.push((b) => b.set(cardRef(lang, word), { lang, word, ...full }, { mergeFields: ["lang", "word", ...Object.keys(full)] }));
        }
        await commitAll(ops);
        light.set(k(lang, word), row);
        return { word, lang, ...row };
      }),
    // In bulk (quick translations for a chapter).
    saveWords: (rows) =>
      call(async () => {
        const prepared = rows.map((r) => {
          const row = { ...(light.get(k(r.lang, r.word)) || blank()) };
          for (const f of LIGHT_FIELDS) if (f in r) row[f] = r[f] ?? null;
          return { word: r.word, lang: r.lang, row };
        });
        await commitAll(bucketOps(prepared));
        for (const p of prepared) light.set(k(p.lang, p.word), p.row);
      }),
    // Adds a chapter's new words and leaves known words untouched.
    registerWords: (words, chapterId, lang) =>
      call(async () => {
        const fresh = words
          .filter((word) => !light.has(k(lang, word)))
          .map((word) => ({ word, lang, row: { ...blank(), first_chapter: chapterId } }));
        if (!fresh.length) return;
        await commitAll(bucketOps(fresh));
        for (const p of fresh) light.set(k(lang, p.word), p.row);
      }),

    /* Settings */
    loadSettings: () =>
      call(async () => {
        const snap = await F.getDoc(userDoc("meta", "settings"));
        return snap.exists() ? snap.data().data || null : null;
      }),
    saveSettings: (data) =>
      call(() => F.setDoc(userDoc("meta", "settings"), { data, updated_at: new Date().toISOString() })),

    /* Backup: the same file format as the earlier Supabase version */
    exportAll: () =>
      call(async () => {
        const chapterSnap = await F.getDocs(userCol("chapters"));
        const chapters = [];
        chapterSnap.forEach((d) => chapters.push({ id: d.id, ...d.data() }));
        const cards = new Map();
        (await F.getDocs(userCol("cards"))).forEach((d) => {
          const v = d.data();
          cards.set(k(v.lang, v.word), v);
        });
        if (!light.size) await api.loadWords();
        const words = [...light].map(([key, row]) => {
          const [lang, word] = key.split("\t");
          const c = cards.get(key) || {};
          return { lang, word, ...row, card: c.card ?? null, contexts: c.contexts || [], notes: c.notes ?? null };
        });
        const settings = (await api.loadSettings()) || {};
        return { app: "palabra-por-palabra", version: 2, exported_at: new Date().toISOString(), chapters: sortChapters(chapters), words, settings };
      }),
    importAll: (backup) =>
      call(async () => {
        // Version 1 backups have no languages: everything in them was Spanish.
        const chapters = (backup.chapters || []).map((c) => ({
          id: String(c.id || F.doc(userCol("chapters")).id),
          title: c.title,
          lang: c.lang || "es",
          paragraphs: c.paragraphs || [],
          position: c.position ?? 0,
          created_at: c.created_at || new Date().toISOString(),
        }));
        const ids = new Set(chapters.map((c) => c.id));
        const index = [...(await loadIndex()).filter((c) => !ids.has(c.id)), ...chapters.map(({ paragraphs, ...meta }) => meta)];
        const ops = chapters.map((c) => (b) => b.set(userDoc("chapters", c.id), { title: c.title, lang: c.lang, paragraphs: c.paragraphs, position: c.position, created_at: c.created_at }));
        ops.push((b) => b.set(indexRef(), { list: index }));
        const words = (backup.words || []).map((w) => ({
          word: w.word,
          lang: w.lang || "es",
          row: {
            level: w.level ?? 5,
            quick: w.quick ?? null,
            has_card: !!w.card,
            first_chapter: ids.has(w.first_chapter) ? w.first_chapter : null,
            learned_at: w.learned_at ?? null,
            srs: w.srs ?? null,
          },
          full: { card: w.card ?? null, contexts: w.contexts ?? [], notes: w.notes ?? null },
        }));
        ops.push(...bucketOps(words));
        for (const w of words) {
          if (w.full.card || w.full.notes || w.full.contexts.length) {
            ops.push((b) => b.set(cardRef(w.lang, w.word), { lang: w.lang, word: w.word, ...w.full }));
          }
        }
        await commitAll(ops);
        chapterIndex = index;
        for (const w of words) light.set(k(w.lang, w.word), w.row);
        if (backup.settings) await api.saveSettings(backup.settings);
      }),
  };
  return api;
}
