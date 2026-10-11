// Splitting chapter text into paragraphs, sentences and words — for any language.
// Words are found with Intl.Segmenter, which also handles Japanese, Chinese and Thai without spaces.
import { langInfo } from "./langs.js";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HAS_SEG = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
const LETTER = /\p{L}/u;
const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+|-[\p{L}\p{M}]+)*/gu;
const HYPHENS = new Set(["-", "‐", "‑"]);
const ELISION_RE = /^(\p{L}+)(['’])(\p{L}.*)$/u;
const END = /[.!?…。！？」』»"”:)）]$/;
const HIRAGANA = /^\p{Script=Hiragana}+$/u;
const ENDS_KANJI = /\p{Script=Han}$/u;
const HAS_KANJI = /\p{Script=Han}/u;
// Verb and adjective endings that follow a word like 帰り or 思い: ます, ました, た, て, ない, られる…
const JA_AUX = /^(ま[すしせ]|ま$|た|て|ない|なかっ|ら|れ|せ|さ|ず|よう|そう)/u;
// Particles and the copula stay separate words; other hiragana after a kanji stem is an inflection.
const JA_STANDALONE = new Set([
  "は", "が", "を", "に", "で", "と", "も", "の", "へ", "や", "か", "ね", "よ", "な", "から", "まで", "より", "など",
  "だけ", "しか", "ばかり", "ほど", "くらい", "ぐらい", "です", "でした", "だ", "だった", "でしょう", "じゃ", "では",
  "けど", "けれど", "ので", "のに", "ても", "でも", "とか",
]);
const CHAPTER_RE =
  /^(?:cap[ií]tulo|chapitre|kapitel|chapter|capitolo|hoofdstuk|kapittel|rozdział|kapitola|fejezet|глава|розділ|κεφάλαιο|bölüm)(?!\p{L})|^第.{1,8}[章話回部节節]/iu;

const segCache = new Map();
function segmenter(lang, granularity) {
  const k = `${lang}|${granularity}`;
  let s = segCache.get(k);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang, { granularity });
    } catch {
      s = new Intl.Segmenter("en", { granularity });
    }
    segCache.set(k, s);
  }
  return s;
}

// The key a word is stored under: lower case, one kind of apostrophe.
export function wordKey(s, lang) {
  const v = String(s).replace(/’/g, "'");
  try {
    return v.toLocaleLowerCase(lang);
  } catch {
    return v.toLowerCase();
  }
}

// For search: "cancion" finds "canción". Only Latin letters lose their accents.
export const searchKey = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .toLowerCase();

export const isChapterHeading = (p) => CHAPTER_RE.test(String(p).trim());

// Joins lines that were broken when copying from a PDF.
export function reflowText(raw, join, lang) {
  const glue = langInfo(lang).noSpace ? "" : " ";
  const lines = String(raw)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim());
  const paras = [];
  let cur = "";
  const flush = () => {
    if (cur) {
      paras.push(cur);
      cur = "";
    }
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (!join) {
      paras.push(line);
      continue;
    }
    if (!cur && paras.length === 0 && isChapterHeading(line)) {
      paras.push(line);
      continue;
    }
    cur = cur ? `${cur}${glue}${line}` : line;
    if (END.test(line)) flush();
  }
  flush();
  return paras;
}

export function splitSentences(p, lang) {
  if (HAS_SEG) return [...segmenter(lang, "sentence").segment(p)].map((s) => s.segment);
  const out = [];
  const re = /[.!?…]+[」"»”)]*\s+|[。！？]+[」』”）]*\s*|」\s+/g;
  let last = 0;
  let m;
  while ((m = re.exec(p)) !== null) {
    const end = m.index + m[0].length;
    out.push(p.slice(last, end));
    last = end;
  }
  if (last < p.length) out.push(p.slice(last));
  return out;
}

function rawSegments(s, lang) {
  const raw = [];
  if (HAS_SEG) {
    for (const part of segmenter(lang, "word").segment(s)) {
      raw.push({ t: part.segment, word: !!part.isWordLike && LETTER.test(part.segment) });
    }
    return raw;
  }
  let last = 0;
  for (const m of s.matchAll(WORD_RE)) {
    if (m.index > last) raw.push({ t: s.slice(last, m.index), word: false });
    raw.push({ t: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) raw.push({ t: s.slice(last), word: false });
  return raw;
}

// The segmenter splits Japanese verbs into pieces (食 | べ | ま | した). Glue the inflection back on.
function glueJapanese(raw) {
  const out = [];
  let chain = false;
  for (const r of raw) {
    const prev = out[out.length - 1];
    const stem = chain || ENDS_KANJI.test(prev?.t) || (HAS_KANJI.test(prev?.t) && JA_AUX.test(r.t));
    if (r.word && prev?.word && HIRAGANA.test(r.t) && !JA_STANDALONE.has(r.t) && stem) {
      prev.t += r.t;
      chain = true;
      continue;
    }
    chain = false;
    out.push({ ...r });
  }
  return out;
}

export function tokenize(s, lang) {
  const info = langInfo(lang);
  let raw = rawSegments(s, lang);
  if (String(lang).split("-")[0] === "ja") raw = glueJapanese(raw);

  // Glue hyphenated words back together: peut-être, arco-iris, E-Mail.
  const glued = [];
  for (let i = 0; i < raw.length; i++) {
    let r = raw[i];
    if (r.word && !info.noSpace) {
      let t = r.t;
      while (i + 2 < raw.length && !raw[i + 1].word && HYPHENS.has(raw[i + 1].t) && raw[i + 2].word) {
        t += raw[i + 1].t + raw[i + 2].t;
        i += 2;
      }
      r = { t, word: true };
    }
    glued.push(r);
  }

  const out = [];
  const pushText = (t) => {
    const last = out[out.length - 1];
    if (last && !last.w) last.t += t;
    else out.push({ t });
  };
  for (const r of glued) {
    if (!r.word) {
      pushText(r.t);
      continue;
    }
    // French and Italian elision: l'homme → l' + homme.
    const m = info.elision && r.t.match(ELISION_RE);
    if (m && info.elision.has(wordKey(m[1], lang))) {
      out.push({ t: m[1] + m[2], w: wordKey(`${m[1]}'`, lang) });
      out.push({ t: m[3], w: wordKey(m[3], lang) });
    } else {
      out.push({ t: r.t, w: wordKey(r.t, lang) });
    }
  }
  return out;
}

export function buildStructure(paragraphs, lang) {
  const short = langInfo(lang).noSpace ? 30 : 70;
  const sentences = [];
  const sentTokens = [];
  const firstOcc = new Map();
  const occ = new Map();
  const tokenList = [];
  const paras = paragraphs.map((p, pi) => {
    const heading = pi === 0 && (isChapterHeading(p) || (p.length < short && !END.test(p)));
    const sents = splitSentences(p, lang).map((text) => {
      const sid = sentences.length;
      const tokens = tokenize(text, lang);
      sentences.push(text);
      sentTokens.push(tokens);
      tokens.forEach((t, ti) => {
        if (!t.w) return;
        tokenList.push([sid, ti]);
        if (!firstOcc.has(t.w)) firstOcc.set(t.w, { sid, ti, surface: t.t });
        if (!occ.has(t.w)) occ.set(t.w, []);
        occ.get(t.w).push([sid, ti]);
      });
      return { sid, tokens };
    });
    return { heading, sents };
  });
  return { paras, sentences, sentTokens, firstOcc, occ, tokenList, tokenCount: tokenList.length };
}

export function contextAround(sentences, sid, lang) {
  const t = [sentences[sid - 1], sentences[sid], sentences[sid + 1]]
    .filter(Boolean)
    .map((s) => s.trim())
    .join(langInfo(lang).noSpace ? "" : " ");
  return t.length > 900 ? `${t.slice(0, 900)}…` : t;
}
