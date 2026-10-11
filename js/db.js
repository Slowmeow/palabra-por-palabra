// Firebase: email sign-in and the Cloud Firestore database.
// The SDK is loaded from Google's own CDN at a fixed version. There is deliberately no third-party fallback:
// whatever loads here runs with the user's session.
//
// Layout (everything lives under users/{uid}, see firestore.rules):
//   meta/settings          { data }
//   meta/chapters          { list: [{ id, title, lang, book, words, position, created_at }] }   — the chapter index
//   chapters/{id}          { title, lang, book, paragraphs, position, created_at }
//   vocab/{lang}~{nn}      { lang, w: { [word]: JSON of the light row } }         — 32 buckets per language
//   cards/{lang}|{word}    { lang, word, card, contexts, notes }                    — loaded when a word opens
//                          card can be { ref } — a pointer to a shared explanation instead of a copy
//
// Shared by everyone (see firestore.rules):
//   profiles/{uid}                    { name, email, created, lastSeen, plan, planUntil, words, cards }
//   admins/{uid}                      created by hand in the console; makes that user an admin
//   shared_dict/{lang}~{xl}~{nn}      { lang, xl, w: { [word]: JSON [translation, pronunciation, reading, ipa, pos, lemma] } }
//   shared_cards/{id}                 { lang, word, xl, by, byName, model, created, likes, f, z | j }  — z: deflated JSON
//   shared_cards/{id}/likes/{uid}     one per person who liked it
//   shared_ctx/{lang}|{xl}|{hash}|{word}   "why this word here" for one exact sentence
//
// Words are packed into buckets so that opening the site costs a few dozen reads, not one per word:
// the free Spark plan allows 50,000 reads and 20,000 writes a day for the whole project.

const VERSION = "12.19.0";
const sdkUrl = (m) => `https://www.gstatic.com/firebasejs/${VERSION}/firebase-${m}.js`;
const [sdkApp, sdkAuth, sdkFs] = await Promise.all(["app", "auth", "firestore"].map((m) => import(sdkUrl(m))));
const SDK = { app: sdkApp, auth: sdkAuth, fs: sdkFs };

const BUCKETS = 32;
const SHARED_BUCKETS = 64;
const BATCH_LIMIT = 400;
const QUICK_KEYS = ["translation", "pronunciation", "reading", "ipa", "pos", "lemma"];
const CARD_KEYS = ["lemma", "translation", "pos", "pronunciation", "reading", "ipa", "etymology", "history", "fact_type", "fact", "relatives", "mnemonic"];
const LIGHT_FIELDS = ["level", "quick", "has_card", "first_chapter", "learned_at", "srs"];
const FULL_FIELDS = ["card", "contexts", "notes"];

const blank = () => ({ level: 5, quick: null, has_card: false, first_chapter: null, learned_at: null, srs: null });

// FNV-1a: spreads words evenly over the buckets.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const bucketOf = (word, n = BUCKETS) => String(hash(word) % n).padStart(2, "0");

// Shared explanations are stored deflated: about half the size of plain JSON.
const canDeflate = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}
// Shared explanations come from other people: keep only the expected fields, as plain strings.
function cleanCard(c) {
  const out = {};
  for (const k of CARD_KEYS) {
    const v = c?.[k];
    if (k === "relatives") out.relatives = Array.isArray(v) ? v.slice(0, 8).map((x) => String(x).slice(0, 200)) : [];
    else if (v != null) out[k] = String(v).slice(0, 4000);
  }
  return out;
}
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] != null && obj[k] !== "").map((k) => [k, obj[k]]));

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
  const dictBucketId = (lang, xl, word) => `${lang}~${xl}~${bucketOf(word, SHARED_BUCKETS)}`;
  const ctxId = (lang, xl, sentence, word) => `${lang}|${xl}|${hash(sentence).toString(36)}${sentence.length.toString(36)}|${word}`;
  const dictCache = new Map(); // bucket id -> { word: JSON } as last read; avoids re-reading in one session
  let profileSeen = null; // the profile as read at sign-in

  async function packCard(card) {
    const json = JSON.stringify(pick(card, CARD_KEYS));
    return canDeflate ? { f: "deflate", z: F.Bytes.fromUint8Array(await deflate(json)) } : { f: "json", j: json };
  }
  async function unpackShared(id, d) {
    let content;
    if (d.f === "deflate" && d.z) {
      if (!canDeflate) return null;
      content = JSON.parse(await inflate(d.z.toUint8Array()));
    } else content = JSON.parse(d.j || "{}");
    return {
      id,
      lang: String(d.lang || ""),
      word: String(d.word || ""),
      xl: String(d.xl || ""),
      by: String(d.by || ""),
      byName: String(d.byName || ""),
      model: String(d.model || ""),
      created: String(d.created || ""),
      likes: Math.max(0, Number(d.likes) || 0),
      card: cleanCard(content),
    };
  }
  const quickToRow = (q) => JSON.stringify(QUICK_KEYS.map((k) => q?.[k] || ""));
  const rowToQuick = (json, xl) => {
    try {
      const a = JSON.parse(json);
      return { ...Object.fromEntries(QUICK_KEYS.map((k, i) => [k, a[i] || ""])), xl };
    } catch {
      return null;
    }
  };

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
    // Chapter text never changes after it is added, so a cached copy is as good as the server's and costs no read.
    getChapter: (id) =>
      call(async () => {
        const ref = userDoc("chapters", id);
        let snap = null;
        try {
          snap = await F.getDocFromCache(ref);
        } catch {
          /* not cached yet */
        }
        if (!snap?.exists()) snap = await F.getDoc(ref);
        if (!snap.exists()) throw new Error("chapter not found");
        const d = snap.data();
        const meta = (chapterIndex || []).find((c) => c.id === id);
        return { id, title: meta?.title || d.title, lang: d.lang, book: meta?.book ?? d.book ?? "", paragraphs: d.paragraphs };
      }),
    addChapter: (title, paragraphs, position, lang, book = "", words = 0) =>
      call(async () => {
        const list = await loadIndex();
        const id = F.doc(userCol("chapters")).id;
        const meta = { id, title, lang, book, words, position, created_at: new Date().toISOString() };
        const next = [...list, meta];
        await commitAll([
          (b) => b.set(userDoc("chapters", id), { title, lang, book, paragraphs, position, created_at: meta.created_at }),
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
    setChapterBook: (id, book) =>
      call(async () => {
        const next = (await loadIndex()).map((c) => (c.id === id ? { ...c, book } : c));
        await commitAll([
          (b) => b.set(userDoc("chapters", id), { book }, { merge: true }),
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
        let card = d.card ?? null;
        let refMissing = false;
        // A card chosen from the library is only a pointer: fetch the shared text.
        if (card?.ref) {
          const shared = await api.getSharedCard(card.ref).catch(() => null);
          if (shared) {
            card = { ...shared.card, meta: { ref: shared.id, by: shared.by, byName: shared.byName, likes: shared.likes, model: shared.model, xl: shared.xl, at: card.at } };
          } else {
            card = null;
            refMissing = true;
          }
        }
        return { word, lang, ...(row || blank()), card, refMissing, contexts: d.contexts || [], notes: d.notes ?? null };
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

    /* Profile and role */
    userInfo() {
      const u = auth.currentUser;
      // Must match myName() in firestore.rules: the display name, or the part of the email before @.
      return { uid: u?.uid || "", email: u?.email || "", name: (u?.displayName || (u?.email || "").split("@")[0]).slice(0, 100) };
    },
    loadRole: () =>
      call(async () => {
        const [p, a] = await Promise.all([F.getDoc(F.doc(db, "profiles", uid)), F.getDoc(F.doc(db, "admins", uid))]);
        profileSeen = p.exists() ? p.data() : null;
        return { profile: profileSeen, admin: a.exists() };
      }),
    // One write per visit: keeps the admin panel's list of users current. The plan is set only by an admin.
    saveProfile: (stats) =>
      call(async () => {
        const me = api.userInfo();
        const now = new Date().toISOString();
        const data = { name: me.name, email: me.email, lastSeen: now, ...stats };
        if (!profileSeen) Object.assign(data, { created: now, plan: "free", planUntil: null });
        // Older versions stored the profile photo; it isn't needed, so it is removed.
        else if ("photo" in profileSeen) data.photo = F.deleteField();
        await F.setDoc(F.doc(db, "profiles", uid), data, { merge: true });
        profileSeen = { ...(profileSeen || {}), ...data };
      }),

    /* Shared quick dictionary */
    // Returns Map(word -> quick) for the words found in the shared dictionary.
    sharedDictLookup: (lang, xl, words) =>
      call(async () => {
        const ids = [...new Set(words.map((w) => dictBucketId(lang, xl, w)))].filter((id) => !dictCache.has(id));
        await Promise.all(
          ids.map(async (id) => {
            const snap = await F.getDoc(F.doc(db, "shared_dict", id));
            dictCache.set(id, snap.exists() ? snap.data().w || {} : {});
          })
        );
        const out = new Map();
        for (const w of words) {
          const json = dictCache.get(dictBucketId(lang, xl, w))?.[w];
          const q = json && rowToQuick(json, xl);
          if (q?.translation) out.set(w, q);
        }
        return out;
      }),
    // Adds new words only; words already in the shared dictionary are never overwritten.
    sharedDictAdd: (lang, xl, entries) =>
      call(async () => {
        const words = entries.map((e) => e.word);
        await api.sharedDictLookup(lang, xl, words);
        const groups = new Map();
        for (const { word, quick } of entries) {
          if (!quick?.translation) continue;
          const id = dictBucketId(lang, xl, word);
          if (dictCache.get(id)?.[word]) continue;
          if (!groups.has(id)) groups.set(id, {});
          groups.get(id)[word] = quickToRow(quick);
        }
        await Promise.allSettled(
          [...groups].map(async ([id, w]) => {
            await F.setDoc(F.doc(db, "shared_dict", id), { lang, xl, w }, { merge: true });
            dictCache.set(id, { ...(dictCache.get(id) || {}), ...w });
          })
        );
      }),

    /* Shared explanations */
    sharedCardsFor: (lang, word) =>
      call(async () => {
        const q = F.query(F.collection(db, "shared_cards"), F.where("lang", "==", lang), F.where("word", "==", word), F.limit(20));
        const snap = await F.getDocs(q);
        const out = await Promise.all(snap.docs.map((d) => unpackShared(d.id, d.data()).catch(() => null)));
        return out.filter(Boolean).sort((a, b) => b.likes - a.likes || String(b.created).localeCompare(String(a.created)));
      }),
    getSharedCard: (id) =>
      call(async () => {
        const snap = await F.getDoc(F.doc(db, "shared_cards", id));
        return snap.exists() ? unpackShared(id, snap.data()) : null;
      }),
    shareCard: ({ lang, word, xl, card, model }) =>
      call(async () => {
        const me = api.userInfo();
        const ref = F.doc(F.collection(db, "shared_cards"));
        const body = { lang, word, xl, by: uid, byName: me.name, model: String(model || "").slice(0, 60), created: new Date().toISOString(), likes: 0, ...(await packCard(card)) };
        await F.setDoc(ref, body);
        return ref.id;
      }),
    likeShared: (id, on) =>
      call(async () => {
        const batch = F.writeBatch(db);
        const likeRef = F.doc(db, "shared_cards", id, "likes", uid);
        if (on) batch.set(likeRef, { at: new Date().toISOString() });
        else batch.delete(likeRef);
        batch.update(F.doc(db, "shared_cards", id), { likes: F.increment(on ? 1 : -1) });
        await batch.commit();
      }),
    deleteShared: (id) => call(() => F.deleteDoc(F.doc(db, "shared_cards", id))),

    /* Shared "why this word here" for an exact sentence */
    getSharedCtx: (lang, xl, sentence, word) =>
      call(async () => {
        const snap = await F.getDoc(F.doc(db, "shared_ctx", ctxId(lang, xl, sentence, word)));
        const d = snap.exists() ? snap.data() : null;
        return d && d.s === sentence.slice(0, 1200) ? d : null;
      }),
    shareCtx: ({ lang, xl, sentence, word, text, ru, tr }) =>
      call(async () => {
        const body = {
          lang, xl, word,
          s: sentence.slice(0, 1200),
          text: String(text || "").slice(0, 3000),
          ru: String(ru || "").slice(0, 3000),
          tr: String(tr || "").slice(0, 300),
          by: uid,
          created: new Date().toISOString(),
        };
        // Create only: if someone already explained this sentence, the rules refuse and that's fine.
        await F.setDoc(F.doc(db, "shared_ctx", ctxId(lang, xl, sentence, word)), body).catch(() => {});
      }),

    /* Admin */
    adminCounts: () =>
      call(async () => {
        const [users, cards] = await Promise.all([
          F.getCountFromServer(F.collection(db, "profiles")),
          F.getCountFromServer(F.collection(db, "shared_cards")),
        ]);
        return { users: users.data().count, cards: cards.data().count };
      }),
    adminUsers: (n = 100) =>
      call(async () => {
        const snap = await F.getDocs(F.query(F.collection(db, "profiles"), F.orderBy("lastSeen", "desc"), F.limit(n)));
        return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
      }),
    adminSetPlan: (who, plan, planUntil) => call(() => F.setDoc(F.doc(db, "profiles", who), { plan, planUntil: planUntil || null }, { merge: true })),
    adminRecentShared: (n = 50) =>
      call(async () => {
        const snap = await F.getDocs(F.query(F.collection(db, "shared_cards"), F.orderBy("created", "desc"), F.limit(n)));
        const out = await Promise.all(snap.docs.map((d) => unpackShared(d.id, d.data()).catch(() => null)));
        return out.filter(Boolean);
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
          book: String(c.book || ""),
          paragraphs: c.paragraphs || [],
          position: c.position ?? 0,
          created_at: c.created_at || new Date().toISOString(),
        }));
        const ids = new Set(chapters.map((c) => c.id));
        const index = [...(await loadIndex()).filter((c) => !ids.has(c.id)), ...chapters.map(({ paragraphs, ...meta }) => meta)];
        const ops = chapters.map((c) => (b) => b.set(userDoc("chapters", c.id), { title: c.title, lang: c.lang, book: c.book, paragraphs: c.paragraphs, position: c.position, created_at: c.created_at }));
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
