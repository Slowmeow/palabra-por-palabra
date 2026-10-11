// Работа с базой данных Supabase.
// Библиотека грузится с CDN. Если первый адрес недоступен, пробуем второй.
let createClient;
try {
  ({ createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"));
} catch {
  ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2"));
}

const LIGHT = "word,level,quick,has_card,first_chapter,learned_at";
const CHUNK = 500;

export function makeDb(url, key, options = {}) {
  const sb = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "ppp-auth" },
    ...options,
  });
  let uid = null;

  const must = (res) => {
    if (res.error) throw new Error(res.error.message || String(res.error));
    return res.data;
  };

  const chunks = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
    return out;
  };

  return {
    async session() {
      const { data } = await sb.auth.getSession();
      uid = data.session?.user?.id || null;
      return data.session;
    },
    userEmail: async () => (await sb.auth.getUser()).data.user?.email || "",
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      uid = data.user.id;
      return data.session;
    },
    async signOut() {
      await sb.auth.signOut();
      uid = null;
    },

    /* Главы */
    async listChapters() {
      return must(
        await sb.from("chapters").select("id,title,position,created_at").order("position").order("created_at")
      );
    },
    async getChapter(id) {
      return must(await sb.from("chapters").select("id,title,paragraphs").eq("id", id).single());
    },
    async addChapter(title, paragraphs, position) {
      return must(
        await sb
          .from("chapters")
          .insert({ user_id: uid, title, paragraphs, position })
          .select("id,title,position,created_at")
          .single()
      );
    },
    async renameChapter(id, title) {
      must(await sb.from("chapters").update({ title }).eq("id", id));
    },
    async deleteChapter(id) {
      must(await sb.from("chapters").delete().eq("id", id));
    },

    /* Слова */
    async loadWords() {
      const out = [];
      const page = 1000;
      for (let from = 0; ; from += page) {
        const data = must(await sb.from("words").select(LIGHT).order("word").range(from, from + page - 1));
        out.push(...data);
        if (data.length < page) break;
      }
      return out;
    },
    async getWordFull(word) {
      return must(await sb.from("words").select("*").eq("word", word).maybeSingle());
    },
    // Сохраняет только переданные поля слова, остальные не трогает.
    async saveWord(fields) {
      return must(
        await sb
          .from("words")
          .upsert({ user_id: uid, ...fields }, { onConflict: "user_id,word" })
          .select(LIGHT)
          .single()
      );
    },
    // Пакетно: у всех строк должен быть одинаковый набор полей.
    async saveWords(rows) {
      for (const part of chunks(rows)) {
        must(
          await sb.from("words").upsert(part.map((r) => ({ user_id: uid, ...r })), { onConflict: "user_id,word" })
        );
      }
    },
    // Добавляет новые слова главы, уже известные слова не меняет.
    async registerWords(words, chapterId) {
      for (const part of chunks(words)) {
        must(
          await sb
            .from("words")
            .upsert(
              part.map((word) => ({ user_id: uid, word, first_chapter: chapterId })),
              { onConflict: "user_id,word", ignoreDuplicates: true }
            )
        );
      }
    },

    /* Настройки */
    async loadSettings() {
      const row = must(await sb.from("settings").select("data").maybeSingle());
      return row?.data || null;
    },
    async saveSettings(data) {
      must(
        await sb
          .from("settings")
          .upsert({ user_id: uid, data, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      );
    },

    /* Резервная копия */
    async exportAll() {
      const chapters = must(await sb.from("chapters").select("*").order("position").order("created_at"));
      const words = [];
      for (let from = 0; ; from += 1000) {
        const data = must(await sb.from("words").select("*").order("word").range(from, from + 999));
        words.push(...data);
        if (data.length < 1000) break;
      }
      const settings = must(await sb.from("settings").select("data").maybeSingle())?.data || {};
      return { app: "palabra-por-palabra", version: 1, exported_at: new Date().toISOString(), chapters, words, settings };
    },
    async importAll(backup) {
      const chapters = (backup.chapters || []).map((c) => ({
        id: c.id,
        user_id: uid,
        title: c.title,
        paragraphs: c.paragraphs,
        position: c.position ?? 0,
        created_at: c.created_at,
      }));
      for (const part of chunks(chapters)) must(await sb.from("chapters").upsert(part, { onConflict: "id" }));
      const words = (backup.words || []).map((w) => ({
        user_id: uid,
        word: w.word,
        level: w.level ?? 5,
        quick: w.quick ?? null,
        card: w.card ?? null,
        contexts: w.contexts ?? [],
        notes: w.notes ?? null,
        first_chapter: chapters.some((c) => c.id === w.first_chapter) ? w.first_chapter : null,
        learned_at: w.learned_at ?? null,
      }));
      for (const part of chunks(words)) must(await sb.from("words").upsert(part, { onConflict: "user_id,word" }));
      if (backup.settings) await this.saveSettings(backup.settings);
    },
  };
}
