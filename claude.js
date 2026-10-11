// Запросы к Claude API прямо из браузера (ключ хранится только у вас).

export const MODELS = [
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    note: "самая сильная, медленнее и дороже всех",
    inPrice: 10,
    outPrice: 50,
    thinking: "always",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    note: "очень сильная",
    inPrice: 5,
    outPrice: 25,
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    note: "быстрая и умная",
    inPrice: 2,
    outPrice: 10,
    thinking: "adaptive",
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    note: "самая быстрая и дешёвая",
    inPrice: 1,
    outPrice: 5,
    thinking: "manual",
    efforts: null,
  },
];

export const EFFORTS = {
  low: "низкое",
  medium: "среднее",
  high: "высокое",
  xhigh: "очень высокое",
  max: "максимальное",
};
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const MAX_TOKENS = { low: 8000, medium: 16000, high: 32000, xhigh: 64000, max: 64000 };

export const FACT_TYPES = ["смешной", "грустный", "жуткий", "удивительный", "исторический"];

export function modelInfo(id) {
  return (
    MODELS.find((m) => m.id === id) || {
      id,
      name: id,
      note: "своя модель",
      inPrice: 0,
      outPrice: 0,
      thinking: "unknown",
      efforts: null,
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

// Очень грубая оценка одного разбора слова: для подсказки, не для бухгалтерии.
export function estimateCardCost(modelId, effort) {
  const m = modelInfo(modelId);
  const thinkingGuess = { low: 400, medium: 900, high: 1800, xhigh: 3500, max: 6000 }[effort] ?? 0;
  const extra = m.efforts ? thinkingGuess : 0;
  return (1100 * m.inPrice + (900 + extra) * m.outPrice) / 1e6;
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
  if (/credit balance|billing/i.test(m)) return "На балансе Claude API закончились деньги. Пополните его в консоли Claude.";
  if (status === 401) return "API-ключ Anthropic не подошёл. Проверьте его в настройках.";
  if (status === 403) return "У этого ключа нет доступа к выбранной модели.";
  if (status === 404) return "Модель не найдена. Проверьте её название в настройках.";
  if (status === 429) return "Слишком много запросов подряд. Подождите минуту и повторите.";
  if (status === 529 || status === 503) return "Серверы Claude сейчас перегружены. Повторите чуть позже.";
  return `Ошибка Claude API (${status || "сеть"}): ${m}`;
}

function headers(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export async function checkKey(apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: headers(apiKey) });
  if (res.ok) return true;
  let msg = "";
  try {
    msg = (await res.json())?.error?.message || "";
  } catch {
    /* пусто */
  }
  throw new ClaudeError(humanize(res.status, msg), res.status);
}

// Потоковый запрос: разбирает события SSE, копит текст и краткий ход размышлений.
export async function callClaude({ apiKey, body, signal, onThinking, onText }) {
  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ClaudeError("Нет связи с Claude API. Проверьте интернет.", 0, "network");
  }
  if (!res.ok) {
    let msg = "";
    try {
      msg = (await res.json())?.error?.message || "";
    } catch {
      /* пусто */
    }
    throw new ClaudeError(humanize(res.status, msg), res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let thinking = "";
  let stopReason = null;
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const takeUsage = (u) => {
    if (!u) return;
    for (const k of Object.keys(usage)) if (typeof u[k] === "number") usage[k] = u[k];
  };

  const handle = (evt) => {
    switch (evt.type) {
      case "message_start":
        takeUsage(evt.message?.usage);
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
  return { text, thinking, usage, stopReason };
}

function buildBody({ model, purpose, effort, showThinking, haikuThinking, prompt, schema, maxTokens }) {
  const info = modelInfo(model);
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  const output = {};
  if (schema) output.format = { type: "json_schema", schema };

  if (purpose === "dictionary") {
    if (info.thinking === "adaptive") body.thinking = { type: "disabled" };
    if (info.efforts) output.effort = "low";
  } else {
    if (info.efforts && effort) output.effort = effort;
    if ((info.thinking === "adaptive" || info.thinking === "always") && showThinking) {
      body.thinking = { type: "adaptive", display: "summarized" };
    } else if (info.thinking === "manual" && haikuThinking) {
      body.thinking = { type: "enabled", budget_tokens: 6000 };
      body.max_tokens = Math.max(body.max_tokens, 14000);
    }
  }
  if (Object.keys(output).length) body.output_config = output;
  return body;
}

function finish(r, model) {
  if (r.stopReason === "refusal") {
    throw new ClaudeError("Модель отказалась отвечать на этот запрос. Попробуйте другую модель.", 200, "refusal");
  }
  if (r.stopReason === "max_tokens") {
    throw new ClaudeError("Ответ оборвался: не хватило лимита токенов. Попробуйте уровень размышления пониже.", 200, "max_tokens");
  }
  let data;
  try {
    data = JSON.parse(r.text);
  } catch {
    const a = r.text.indexOf("{");
    const b = r.text.lastIndexOf("}");
    try {
      data = JSON.parse(r.text.slice(a, b + 1));
    } catch {
      throw new ClaudeError("Ответ модели пришёл не в формате JSON. Повторите запрос.", 200, "parse");
    }
  }
  return { data, usage: r.usage, cost: costUsd(model, r.usage), model };
}

/* ---------- Схемы ответов ---------- */

const str = { type: "string" };

export const CARD_SCHEMA = {
  type: "object",
  properties: {
    lemma: str,
    translation: str,
    pos: str,
    pronunciation: str,
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
    "lemma", "translation", "pos", "pronunciation", "ipa", "sentence_translation",
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
        properties: { word: str, translation: str, pronunciation: str, ipa: str, pos: str, lemma: str },
        required: ["word", "translation", "pronunciation", "ipa", "pos", "lemma"],
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

/* ---------- Промпты ---------- */

function cardPrompt({ surface, sentence, context, wish }) {
  return `Ты — увлечённый преподаватель испанского и историк языка. Твой ученик говорит по-русски и учит испанский, читая книгу слово за словом. Он нажал на слово в тексте. Объясни это слово так, чтобы оно запомнилось надолго.

Слово (как в тексте): «${surface}»
Предложение, где оно стоит: «${sentence}»
Фрагмент вокруг: «${context}»

Заполни поля ответа:
- lemma: словарная форма (инфинитив для глагола, ед. ч. м. р. для прилагательного)
- translation: перевод на русский именно в этом значении, 1–4 слова
- pos: часть речи и форма коротко, например «глагол, претерито, 3 л. ед. ч.»
- pronunciation: произношение русскими буквами, ударный слог заглавными, например «су-фри-МЬЕН-то»
- ipa: транскрипция МФА (кастильское произношение)
- sentence_translation: перевод всего предложения на русский
- context: 1–2 предложения — почему здесь стоит именно это слово или эта форма, что оно делает в предложении и в сцене, какой оттенок даёт
- etymology: 1–2 предложения — язык-источник и цепочка форм
- history: 2–3 предложения — как менялось значение, как слово или его корень жили в культуре
- fact_type: смешной, грустный, жуткий, удивительный или исторический
- fact: 1–2 предложения — один запоминающийся правдивый факт о слове или корне
- relatives: 2–4 родственных или похожих слова в русском, английском или других языках, с пометкой языка, например «suffer (англ.)»
- mnemonic: одна короткая яркая ассоциация, чтобы запомнить слово

Правила:
- Пиши по-русски, живо и конкретно, без воды.
- Не выдумывай. Если яркого проверенного факта о самом слове нет, дай настоящий факт о его корне, родственниках или употреблении. Не придумывай цитаты и точные даты. Если в чём-то не уверен, коротко так и скажи.
- Для служебных слов (артикли, предлоги, союзы, местоимения) расскажи, из какого латинского слова они выросли и какую роль играют.
- Для имён собственных объясни, что это имя, как оно устроено и что может значить, с оговоркой, если точно неизвестно.
- Текст может быть переводом с другого языка — тогда в context можно говорить о выборе переводчика.${
    wish ? `\n\nПожелание ученика к этому разбору: ${wish}` : ""
  }`;
}

function dictPrompt(items) {
  const list = items.map((it, i) => `${i + 1}. ${it.word} — «${it.sentence}»`).join("\n");
  return `Ты — испанско-русский словарь для ученика, который читает художественный текст.
Для каждого слова дай короткую словарную статью. Рядом со словом стоит предложение, где оно встретилось: по нему выбирай главное значение.

Поля:
- word: слово точно как в списке
- translation: 1–3 перевода на русский через запятую, первым — значение из этого предложения
- pronunciation: произношение русскими буквами, ударный слог заглавными
- ipa: транскрипция МФА (кастильское произношение)
- pos: часть речи и форма коротко
- lemma: словарная форма

Для имён собственных в translation напиши русскую передачу имени и пометку «имя».
Верни все ${items.length} слов в том же порядке, ничего не пропускай.

Слова:
${list}`;
}

function contextPrompt({ surface, lemma, translation, sentence, context }) {
  return `Ты — преподаватель испанского для русскоязычного ученика, который читает книгу слово за словом.
Слово: «${surface}» (словарная форма: ${lemma || surface}; основное значение: ${translation || "—"}).
Предложение: «${sentence}»
Фрагмент вокруг: «${context}»

Заполни поля:
- context: 1–2 предложения по-русски — почему здесь стоит именно это слово или эта форма, что оно делает в этом предложении и в сцене, какой оттенок даёт. Если значение здесь отличается от основного, скажи об этом.
- translation: перевод слова именно в этом месте, 1–4 слова
- sentence_translation: перевод всего предложения на русский`;
}

/* ---------- Публичные функции ---------- */

export async function generateCard({ apiKey, settings, surface, sentence, context, wish, signal, onThinking }) {
  const model = settings.cardModel;
  const info = modelInfo(model);
  const effort = info.efforts ? settings.cardEffort : null;
  const body = buildBody({
    model,
    purpose: "card",
    effort,
    showThinking: settings.showThinking,
    haikuThinking: settings.haikuThinking,
    prompt: cardPrompt({ surface, sentence, context, wish }),
    schema: CARD_SCHEMA,
    maxTokens: effort ? MAX_TOKENS[effort] : 8000,
  });
  const r = await callClaude({ apiKey, body, signal, onThinking });
  const out = finish(r, model);
  out.effort = effort;
  return out;
}

export async function explainContext({ apiKey, settings, surface, lemma, translation, sentence, context, signal }) {
  const model = settings.cardModel;
  const info = modelInfo(model);
  const effort = info.efforts ? capEffort(settings.cardEffort, "medium") : null;
  const body = buildBody({
    model,
    purpose: "context",
    effort,
    showThinking: false,
    haikuThinking: false,
    prompt: contextPrompt({ surface, lemma, translation, sentence, context }),
    schema: CONTEXT_SCHEMA,
    maxTokens: effort ? MAX_TOKENS[effort] : 4000,
  });
  return finish(await callClaude({ apiKey, body, signal }), model);
}

export async function lookupWords({ apiKey, model, items, signal }) {
  const body = buildBody({
    model,
    purpose: "dictionary",
    prompt: dictPrompt(items),
    schema: DICT_SCHEMA,
    maxTokens: Math.min(32000, 1500 + items.length * 160),
  });
  const out = finish(await callClaude({ apiKey, body, signal }), model);
  const map = new Map();
  for (const it of out.data.items || []) {
    const key = String(it.word || "").toLocaleLowerCase("es").trim();
    if (!key) continue;
    map.set(key, {
      translation: it.translation || "",
      pronunciation: it.pronunciation || "",
      ipa: it.ipa || "",
      pos: it.pos || "",
      lemma: it.lemma || "",
    });
  }
  return { map, cost: out.cost, usage: out.usage };
}
