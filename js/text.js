// Разбор текста главы на абзацы, предложения и слова.

export const WORD_RE = /\p{L}+(?:['’-]\p{L}+)*/gu;

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function plural(n, one, few, many) {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

// Склеивает строки, разорванные при копировании из PDF.
export function reflowText(raw, join) {
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
  const END = /[.!?…」»"”:)]$/;
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (!join) {
      paras.push(line);
      continue;
    }
    if (!cur && paras.length === 0 && /^cap[ií]tulo\b/i.test(line)) {
      paras.push(line);
      continue;
    }
    cur = cur ? `${cur} ${line}` : line;
    if (END.test(line)) flush();
  }
  flush();
  return paras;
}

export function splitSentences(p) {
  const out = [];
  const re = /[.!?…]+[」"»”)]*\s+|」\s+/g;
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

export function tokenize(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(WORD_RE)) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    out.push({ t: m[0], w: m[0].toLocaleLowerCase("es") });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

export function buildStructure(paragraphs) {
  const sentences = [];
  const sentTokens = [];
  const firstOcc = new Map();
  const occ = new Map();
  const tokenList = [];
  const paras = paragraphs.map((p, pi) => {
    const heading = pi === 0 && (/^cap[ií]tulo\b/i.test(p) || (p.length < 70 && !/[.!?…」»"”]$/.test(p)));
    const sents = splitSentences(p).map((text) => {
      const sid = sentences.length;
      const tokens = tokenize(text);
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

export function contextAround(sentences, sid) {
  const t = [sentences[sid - 1], sentences[sid], sentences[sid + 1]]
    .filter(Boolean)
    .map((s) => s.trim())
    .join(" ");
  return t.length > 900 ? `${t.slice(0, 900)}…` : t;
}
