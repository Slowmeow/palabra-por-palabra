// Languages: the one you read (study language) and the one explanations are written in.
// Any BCP 47 code works. The profiles below only add tweaks where a language needs them.
import { uiLang } from "./i18n.js";

const FR_ELISION = ["l", "d", "j", "m", "n", "s", "t", "c", "ç", "qu", "jusqu", "lorsqu", "puisqu", "quoiqu"];
const IT_ELISION = ["l", "un", "dell", "dall", "nell", "sull", "all", "coll", "quest", "quell", "c", "d", "m", "t", "s", "v", "n", "anch", "com", "dov"];
const CA_ELISION = ["l", "d", "m", "t", "s", "n"];

const nonLatin = (X, native) =>
  `if ${X} is written in a non-Latin script, use that script's usual transcription of ${native} instead (for example the Polivanov system for Japanese in Russian)`;

const PROFILES = {
  es: { tts: "es-ES", ipa: "Castilian Spanish", dicts: ["rae", "dechile"] },
  fr: {
    tts: "fr-FR",
    ipa: "standard French",
    elision: FR_ELISION,
    dicts: ["cnrtl", "larousse"],
    hint: "Mention silent letters, liaison or elision when they matter for this word.",
  },
  de: {
    tts: "de-DE",
    ipa: "Standard German",
    dicts: ["dwds"],
    hint: "For nouns give the article and the plural (e.g. der Hund, -e). For compound words split the compound into its parts. For separable verbs name the prefix.",
  },
  ja: {
    tts: "ja-JP",
    noSpace: true,
    ipa: "standard Tokyo Japanese",
    reading: "hiragana",
    pron: (X) => `Hepburn romaji, syllables separated by hyphens, no stress marks; ${nonLatin(X, "Japanese")}`,
    dicts: ["jisho"],
    hint: "For words written with kanji, explain what each kanji means and how they combine; for Sino-Japanese words mention the Chinese origin. For conjugated forms name the dictionary form and the conjugation. Mention politeness level or register when it matters.",
  },
  zh: {
    tts: "zh-CN",
    noSpace: true,
    ipa: "Standard Mandarin",
    pron: () => "Hanyu Pinyin with tone marks",
    dicts: ["mdbg"],
    hint: "Explain what each character means and how they combine.",
  },
  ko: {
    tts: "ko-KR",
    ipa: "standard Seoul Korean",
    pron: (X) => `Revised Romanization of Korean, syllables separated by hyphens; ${nonLatin(X, "Korean")}`,
    hint: "Name particles and verb endings. For Sino-Korean words give the hanja.",
  },
  th: { tts: "th-TH", noSpace: true, pron: () => "RTGS romanization with tone names in brackets" },
  it: { tts: "it-IT", ipa: "standard Italian", elision: IT_ELISION },
  pt: { tts: "pt-BR", ipa: "Brazilian Portuguese" },
  ca: { tts: "ca-ES", ipa: "Central Catalan", elision: CA_ELISION },
  en: { tts: "en-GB", ipa: "British English (RP)", dicts: ["etymonline"] },
  ru: { tts: "ru-RU", hint: "Mark the stressed vowel in the pronunciation." },
  uk: { tts: "uk-UA", hint: "Mark the stressed vowel in the pronunciation." },
  ar: {
    tts: "ar-SA",
    rtl: true,
    pron: () => "simple Latin transliteration with long vowels marked",
    hint: "Give the root (radicals) and the pattern (wazn). Mention vowels that the script leaves unwritten.",
  },
  he: {
    tts: "he-IL",
    rtl: true,
    pron: () => "simple Latin transliteration, stressed syllable in CAPITALS",
    hint: "Give the root (shoresh) and, for verbs, the binyan. Mention vowels the unpointed script leaves out.",
  },
  fa: { tts: "fa-IR", rtl: true, pron: () => "simple Latin transliteration" },
  ur: { tts: "ur-PK", rtl: true, pron: () => "simple Latin transliteration" },
  la: {
    tts: "it-IT",
    ipa: "reconstructed Classical Latin",
    hint: "For verbs give the principal parts; for nouns the genitive and gender.",
  },
};

// Languages offered in the menus. Anything else can be entered as a code.
export const STUDY_LANGS = [
  "es", "fr", "de", "ja", "it", "pt", "en", "ca", "nl", "sv", "nb", "da", "fi", "pl", "cs", "hu", "ro",
  "uk", "ru", "el", "tr", "ar", "he", "fa", "hi", "zh", "ko", "vi", "id", "th", "la",
];
export const EXPLAIN_LANGS = [
  "en", "ru", "uk", "es", "fr", "de", "it", "pt", "pl", "nl", "cs", "tr", "ja", "zh", "ko", "ar", "he", "hi",
];

export function langInfo(code) {
  const base = String(code || "").split("-")[0].toLowerCase();
  const p = PROFILES[code] || PROFILES[base] || {};
  return { code, tts: p.tts || code, ...p, elision: p.elision ? new Set(p.elision) : null };
}

export function isLangTag(code) {
  try {
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code) && Intl.getCanonicalLocales(code).length === 1;
  } catch {
    return false;
  }
}

export const canonLang = (code) => {
  try {
    return Intl.getCanonicalLocales(code)[0];
  } catch {
    return code;
  }
};

const nameCache = new Map();
function displayName(code, inLang) {
  const k = `${inLang}|${code}`;
  if (nameCache.has(k)) return nameCache.get(k);
  let n = code;
  try {
    n = new Intl.DisplayNames([inLang, "en"], { type: "language" }).of(code) || code;
  } catch {
    /* old browser: keep the code */
  }
  n = n.charAt(0).toLocaleUpperCase(inLang) + n.slice(1);
  nameCache.set(k, n);
  return n;
}

// Name in the interface language: "Spanish" / "Испанский".
export const langName = (code) => displayName(code, uiLang());
// Name in English, for prompts.
export const englishName = (code) => displayName(code, "en");
// Short badge: "ES", "JA".
export const langCode = (code) => String(code || "").split("-")[0].toUpperCase();

/* ---------- External dictionaries ---------- */

const REVERSO = {
  ar: "arabic", de: "german", en: "english", es: "spanish", fr: "french", he: "hebrew", it: "italian", ja: "japanese",
  nl: "dutch", pl: "polish", pt: "portuguese", ro: "romanian", ru: "russian", sv: "swedish", tr: "turkish",
  uk: "ukrainian", zh: "chinese",
};
const WIKTIONARIES = new Set(["en", "ru", "uk", "es", "fr", "de", "it", "pt", "pl", "nl", "cs", "tr", "ja", "zh", "ko", "el", "fi", "sv", "hu"]);

const e = encodeURIComponent;
const SITES = {
  rae: (w, l) => ["RAE", `https://dle.rae.es/${e(l)}`],
  dechile: (w, l) => ["Etimologías", `https://etimologias.dechile.net/?${e(l)}`],
  cnrtl: (w, l) => ["CNRTL", `https://www.cnrtl.fr/definition/${e(l)}`],
  larousse: (w, l) => ["Larousse", `https://www.larousse.fr/dictionnaires/francais/${e(l)}`],
  dwds: (w, l) => ["DWDS", `https://www.dwds.de/wb/${e(l)}`],
  jisho: (w, l) => ["Jisho", `https://jisho.org/search/${e(l)}`],
  mdbg: (w) => ["MDBG", `https://www.mdbg.net/chinese/dictionary?wdqb=${e(w)}`],
  etymonline: (w, l) => ["Etymonline", `https://www.etymonline.com/word/${e(l)}`],
};

export function dictLinks(lang, word, lemma, xl) {
  const base = String(lang).split("-")[0];
  const xbase = String(xl).split("-")[0];
  const l = String(lemma || word).trim() || word;
  const out = (langInfo(lang).dicts || []).map((k) => SITES[k](word, l));
  out.push(["Wiktionary", `https://en.wiktionary.org/wiki/${e(l)}#${englishName(base).replace(/ /g, "_")}`]);
  if (xbase !== "en" && WIKTIONARIES.has(xbase)) out.push([`Wiktionary ${langCode(xbase)}`, `https://${xbase}.wiktionary.org/wiki/${e(l)}`]);
  if (REVERSO[base] && REVERSO[xbase] && base !== xbase) {
    out.push(["Reverso", `https://context.reverso.net/translation/${REVERSO[base]}-${REVERSO[xbase]}/${e(word)}`]);
  }
  out.push(["Forvo", `https://forvo.com/word/${e(word)}/#${base}`]);
  return out.map(([label, url]) => ({ label, url }));
}
