// Claude API requests straight from the browser (the key stays in your browser).
import { t } from "./i18n.js";
import { langInfo, englishName } from "./langs.js";
import { wordKey } from "./text.js";

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// off: how to switch thinking off for quick dictionary lookups (null = it cannot be switched off).
// fallback: the model supports server-side fallback to another model if it declines a request.
export const MODELS = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", inPrice: 10, outPrice: 50, thinking: "adaptive", off: null, efforts: ALL_EFFORTS, fallback: true },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", inPrice: 4, outPrice: 20, thinking: "adaptive", off: null, efforts: ALL_EFFORTS, fallback: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", inPrice: 2, outPrice: 10, thinking: "adaptive", off: { type: "between_tools" }, efforts: ALL_EFFORTS, fallback: true },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", inPrice: 0.1, outPrice: 0.5, thinking: "adaptive", off: { type: "disabled" }, efforts: ALL_EFFORTS, fallback: false },
  { id: "claude-opus-5", name: "Claude Opus 5", inPrice: 5, outPrice: 25, thinking: "adaptive", off: { type: "disabled" }, efforts: ALL_EFFORTS, fallback: true, legacy: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", inPrice: 2, outPrice: 10, thinking: "adaptive", off: { type: "disabled" }, efforts: ALL_EFFORTS, fallback: false, legacy: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", inPrice: 1, outPrice: 5, thinking: "manual", off: null, efforts: null, fallback: false, legacy: true },
];
const ALIASES = { "claude-haiku-4-5-20251001": "claude-haiku-4-5" };

export const EFFORT_ORDER = ALL_EFFORTS;
const MAX_TOKENS = { low: 8000, medium: 16000, high: 32000, xhigh: 64000, max: 64000 };
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const FACT_TYPES = ["funny", "sad", "creepy", "surprising", "historical"];
// Cards made by older versions used Russian fact types.
const LEGACY_FACTS = { смешной: "funny", грустный: "sad", жуткий: "creepy", удивительный: "surprising", исторический: "historical" };
export const factKey = (v) => {
  const k = String(v || "").toLowerCase();
  return FACT_TYPES.includes(k) ? k : LEGACY_FACTS[k] || "surprising";
};

export function modelInfo(id) {
  const real = ALIASES[id] || id;
  return (
    MODELS.find((m) => m.id === real) || {
      id,
      name: id,
      inPrice: 0,
      outPrice: 0,
      thinking: "unknown",
      off: null,
      efforts: null,
      fallback: false,
      custom: true,
    }
  );
}

export function capEffort(effort, cap) {
  const i = EFFORT_ORDER.indexOf(effort);
  const j = EFFORT_ORDER.indexOf(cap);
  if (i < 0) return cap;
  return EFFORT_ORDER[Math.min(i, j)];
}

export function costUsd(modelId, usage) {
  const m = modelInfo(modelId);
  const input = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) * 1.25 + (usage?.cache_read_input_tokens || 0) * 0.1;
  return (input * m.inPrice + (usage?.output_tokens || 0) * m.outPrice) / 1e6;
}

// A very rough estimate of one word analysis: a hint, not accounting.
export function estimateCardCost(modelId, effort) {
  const m = modelInfo(modelId);
  const thinkingGuess = { low: 400, medium: 900, high: 1800, xhigh: 3500, max: 6000 }[effort] ?? 0;
  const extra = m.efforts ? thinkingGuess : 0;
  return (1200 * m.inPrice + (950 + extra) * m.outPrice) / 1e6;
}

export class ClaudeError extends Error {
  constructor(message, status = 0, kind = "api") {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

function humanize(status, message) {
  const m = String(message || "");
  if (/credit balance|billing/i.test(m)) return t("api.credit");
  if (status === 401) return t("api.401");
  if (status === 403) return t("api.403");
  if (status === 404) return t("api.404");
  if (status === 429) return t("api.429");
  if (status === 529 || status === 503) return t("api.overloaded");
  return t("api.other", { status: status || t("api.network"), msg: m });
}

function headers(apiKey, betas = []) {
  const h = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (betas.length) h["anthropic-beta"] = betas.join(",");
  return h;
}

async function errorMessage(res) {
  try {
    return (await res.json())?.error?.message || "";
  } catch {
    return "";
  }
}

export async function checkKey(apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: headers(apiKey) });
  if (res.ok) return true;
  throw new ClaudeError(humanize(res.status, await errorMessage(res)), res.status);
}

// If the account cannot use server-side fallback, stop asking for it for the rest of the session.
let fallbackRejected = false;

// Streaming request: parses SSE events, collects the text and the short thinking summary.
export async function callClaude({ apiKey, body, betas = [], signal, onThinking, onText }) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: headers(apiKey, betas),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ClaudeError(t("api.offline"), 0, "network");
  }
  if (!res.ok) {
    const msg = await errorMessage(res);
    if (res.status === 400 && body.fallbacks && /fallback/i.test(msg)) {
      fallbackRejected = true;
      const { fallbacks, ...rest } = body;
      return callClaude({ apiKey, body: rest, betas: betas.filter((b) => b !== FALLBACK_BETA), signal, onThinking, onText });
    }
    throw new ClaudeError(humanize(res.status, msg), res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let thinking = "";
  let stopReason = null;
  let model = body.model;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const takeUsage = (u) => {
    if (!u) return;
    for (const k of Object.keys(usage)) if (typeof u[k] === "number") usage[k] = u[k];
  };

  const handle = (evt) => {
    switch (evt.type) {
      case "message_start":
        if (evt.message?.model) model = evt.message.model;
        takeUsage(evt.message?.usage);
        break;
      case "content_block_start":
        // Server-side fallback: another model continues the answer.
        if (evt.content_block?.type === "fallback" && evt.content_block.to?.model) model = evt.content_block.to.model;
        break;
      case "content_block_delta":
        if (evt.delta?.type === "text_delta") {
          text += evt.delta.text;
          onText?.(text);
        } else if (evt.delta?.type === "thinking_delta") {
          thinking += evt.delta.thinking;
          onThinking?.(thinking);
        }
        break;
      case "message_delta":
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        takeUsage(evt.usage);
        break;
      case "error":
        throw new ClaudeError(humanize(evt.error?.type === "overloaded_error" ? 529 : 0, evt.error?.message), 0);
      default:
        break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      handle(evt);
    }
  }
  return { text, thinking, usage, stopReason, model };
}

function buildRequest({ model, purpose, effort, showThinking, haikuThinking, prompt, schema, maxTokens }) {
  const info = modelInfo(model);
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  const betas = [];
  const output = {};
  if (schema) output.format = { type: "json_schema", schema };

  if (purpose === "dictionary") {
    if (info.efforts) output.effort = "low";
    if (info.off) body.thinking = info.off;
  } else {
    if (info.efforts && effort) output.effort = effort;
    if (info.thinking === "adaptive" && showThinking) {
      body.thinking = { type: "adaptive", display: "summarized" };
    } else if (info.thinking === "manual" && haikuThinking) {
      body.thinking = { type: "enabled", budget_tokens: 6000 };
      body.max_tokens = Math.max(body.max_tokens, 14000);
    }
  }
  if (Object.keys(output).length) body.output_config = output;
  if (info.fallback && !fallbackRejected) {
    body.fallbacks = "default";
    betas.push(FALLBACK_BETA);
  }
  return { body, betas };
}

function finish(r, requested) {
  if (r.stopReason === "refusal") throw new ClaudeError(t("api.refusal"), 200, "refusal");
  if (r.stopReason === "max_tokens") throw new ClaudeError(t("api.maxTokens"), 200, "max_tokens");
  let data;
  try {
    data = JSON.parse(r.text);
  } catch {
    const a = r.text.indexOf("{");
    const b = r.text.lastIndexOf("}");
    try {
      data = JSON.parse(r.text.slice(a, b + 1));
    } catch {
      throw new ClaudeError(t("api.notJson"), 200, "parse");
    }
  }
  const model = r.model || requested;
  return { data, usage: r.usage, cost: costUsd(model, r.usage), model };
}

/* ---------- Response schemas ---------- */

const str = { type: "string" };

export const CARD_SCHEMA = {
  type: "object",
  properties: {
    lemma: str,
    translation: str,
    pos: str,
    pronunciation: str,
    reading: str,
    ipa: str,
    sentence_translation: str,
    context: str,
    etymology: str,
    history: str,
    fact_type: { type: "string", enum: FACT_TYPES },
    fact: str,
    relatives: { type: "array", items: str },
    mnemonic: str,
  },
  required: [
    "lemma", "translation", "pos", "pronunciation", "reading", "ipa", "sentence_translation",
    "context", "etymology", "history", "fact_type", "fact", "relatives", "mnemonic",
  ],
  additionalProperties: false,
};

const DICT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { word: str, translation: str, pronunciation: str, reading: str, ipa: str, pos: str, lemma: str },
        required: ["word", "translation", "pronunciation", "reading", "ipa", "pos", "lemma"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

const CONTEXT_SCHEMA = {
  type: "object",
  properties: { context: str, translation: str, sentence_translation: str },
  required: ["context", "translation", "sentence_translation"],
  additionalProperties: false,
};

/* ---------- Prompts ---------- */

function names(lang, xl) {
  const p = langInfo(lang);
  const L = englishName(lang);
  const X = englishName(xl);
  return {
    p,
    L,
    X,
    pron: p.pron
      ? p.pron(X)
      : `a simple respelling that a ${X} speaker can read, in ${X} script, syllables separated by hyphens, the stressed syllable in CAPITALS`,
    reading: p.reading ? `the reading of the word in ${p.reading}` : "an empty string",
    ipa: `IPA transcription (${p.ipa || `standard ${L}`})`,
  };
}

function cardPrompt({ lang, xl, surface, sentence, context, wish }) {
  const n = names(lang, xl);
  return `You are an enthusiastic ${n.L} teacher and a historian of language. Your student reads a book in ${n.L} word by word and wants every explanation in ${n.X}. They tapped a word in the text. Explain it so that it sticks for a long time.

Word (as it appears in the text): «${surface}»
Sentence it appears in: «${sentence}»
Surrounding passage: «${context}»

Fill in the fields:
- lemma: the dictionary form (infinitive for verbs, base form for adjectives and nouns)
- translation: ${n.X} translation of the word in this exact sense, 1–4 words
- pos: part of speech and grammatical form, briefly, in ${n.X}
- pronunciation: ${n.pron}
- reading: ${n.reading}
- ipa: ${n.ipa}
- sentence_translation: translation of the whole sentence into ${n.X}
- context: 1–2 sentences — why this word or this form is used here, what it does in the sentence and in the scene, what shade of meaning it adds
- etymology: 1–2 sentences — the source language and the chain of forms
- history: 2–3 sentences — how the meaning changed, how the word or its root lived in culture
- fact_type: one of funny, sad, creepy, surprising, historical
- fact: 1–2 sentences — one memorable, true fact about the word or its root
- relatives: 2–4 related or similar words in ${n.X}, English or other languages, each with its language named in ${n.X}, e.g. "suffer (English)"
- mnemonic: one short, vivid association to remember the word

Rules:
- Write every explanatory field in ${n.X}. Quote ${n.L} words as they are.
- Be lively and concrete, no filler.
- Do not invent anything. If there is no striking verified fact about the word itself, give a real fact about its root, its relatives or its use. Do not make up quotes or exact dates. If you are unsure about something, say so briefly.
- For function words (articles, prepositions, conjunctions, pronouns, particles), explain what they grew out of and what role they play.
- For proper names, explain what kind of name it is, how it is built and what it may mean, with a caveat if this is uncertain.
- The text may be a translation from another language; then the context field may discuss the translator's choice.${
    n.p.hint ? `\n- ${n.p.hint}` : ""
  }${wish ? `\n\nThe student's wish for this explanation: ${wish}` : ""}`;
}

function dictPrompt({ lang, xl, items }) {
  const n = names(lang, xl);
  const list = items.map((it, i) => `${i + 1}. ${it.word} — «${it.sentence}»`).join("\n");
  return `You are a ${n.L}–${n.X} dictionary for a learner who reads fiction in ${n.L}.
Give a short dictionary entry for every word. Each word comes with the sentence where it appeared: use it to choose the main sense.

Fields:
- word: the word exactly as in the list
- translation: 1–3 ${n.X} translations separated by commas, the sense from this sentence first
- pronunciation: ${n.pron}
- reading: ${n.reading}
- ipa: ${n.ipa}
- pos: part of speech and form, briefly, in ${n.X}
- lemma: the dictionary form

For proper names, put the usual ${n.X} rendering of the name in translation and mark it as a name, in ${n.X}.
Return all ${items.length} words in the same order and skip nothing.

Words:
${list}`;
}

function contextPrompt({ lang, xl, surface, lemma, translation, sentence, context }) {
  const n = names(lang, xl);
  return `You are a ${n.L} teacher for a student who reads a book word by word and wants explanations in ${n.X}.
Word: «${surface}» (dictionary form: ${lemma || surface}; main meaning: ${translation || "—"}).
Sentence: «${sentence}»
Surrounding passage: «${context}»

Fill in the fields, in ${n.X}:
- context: 1–2 sentences — why this word or this form is used here, what it does in this sentence and in the scene, what shade of meaning it adds. If the meaning here differs from the main one, say so.
- translation: translation of the word in this exact place, 1–4 words
- sentence_translation: translation of the whole sentence`;
}

/* ---------- Public functions ---------- */

export async function generateCard({ apiKey, settings, lang, xl, surface, sentence, context, wish, signal, onThinking }) {
  const model = settings.cardModel;
  const info = modelInfo(model);
  const effort = info.efforts ? settings.cardEffort : null;
  const { body, betas } = buildRequest({
    model,
    purpose: "card",
    effort,
    showThinking: settings.showThinking,
    haikuThinking: settings.haikuThinking,
    prompt: cardPrompt({ lang, xl, surface, sentence, context, wish }),
    schema: CARD_SCHEMA,
    maxTokens: effort ? MAX_TOKENS[effort] : 8000,
  });
  const out = finish(await callClaude({ apiKey, body, betas, signal, onThinking }), model);
  out.effort = effort;
  return out;
}

export async function explainContext({ apiKey, settings, lang, xl, surface, lemma, translation, sentence, context, signal }) {
  const model = settings.cardModel;
  const info = modelInfo(model);
  const effort = info.efforts ? capEffort(settings.cardEffort, "medium") : null;
  const { body, betas } = buildRequest({
    model,
    purpose: "context",
    effort,
    prompt: contextPrompt({ lang, xl, surface, lemma, translation, sentence, context }),
    schema: CONTEXT_SCHEMA,
    maxTokens: effort ? MAX_TOKENS[effort] : 4000,
  });
  return finish(await callClaude({ apiKey, body, betas, signal }), model);
}

// items: [{ word: surface form, sentence }]. Returns a map keyed by wordKey().
export async function lookupWords({ apiKey, model, lang, xl, items, signal }) {
  const { body, betas } = buildRequest({
    model,
    purpose: "dictionary",
    prompt: dictPrompt({ lang, xl, items }),
    schema: DICT_SCHEMA,
    maxTokens: Math.min(32000, 1500 + items.length * 180),
  });
  const out = finish(await callClaude({ apiKey, body, betas, signal }), model);
  const map = new Map();
  for (const it of out.data.items || []) {
    const key = wordKey(String(it.word || "").trim(), lang);
    if (!key) continue;
    map.set(key, {
      translation: it.translation || "",
      pronunciation: it.pronunciation || "",
      reading: it.reading || "",
      ipa: it.ipa || "",
      pos: it.pos || "",
      lemma: it.lemma || "",
      xl,
    });
  }
  return { map, cost: out.cost, usage: out.usage };
}
