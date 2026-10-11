// Reading books from files: EPUB (a zip of XHTML chapters) and plain text.
// Everything happens in the browser; nothing is uploaded except the chapters you import.
import { isChapterHeading } from "./text.js";

const MAX_ENTRY = 30 * 1024 * 1024; // an entry that inflates beyond this is refused (zip bombs)
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function inflateRaw(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ENTRY) {
      reader.cancel();
      throw new Error("a file inside the book is too large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Minimal zip reader: the central directory, then stored or deflated entries. Enough for EPUB.
function readZip(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not-epub");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("not-epub");
    const nameLen = view.getUint16(p + 28, true);
    const name = names.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), local: view.getUint32(p + 42, true) });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return {
    has: (name) => entries.has(name),
    async text(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`missing ${name}`);
      if (view.getUint32(e.local, true) !== 0x04034b50) throw new Error("not-epub");
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      const raw = u8.subarray(start, start + e.size);
      if (e.method !== 0 && e.method !== 8) throw new Error("unsupported compression");
      return new TextDecoder("utf-8").decode(e.method === 0 ? raw : await inflateRaw(raw));
    },
  };
}

function resolvePath(base, href) {
  const dir = base.slice(0, base.lastIndexOf("/") + 1);
  const out = [];
  for (const part of (dir + decodeURIComponent(href.split("#")[0])).split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

const parseXml = (text) => new DOMParser().parseFromString(text, "application/xml");
// DOMParser never runs scripts; only text is read from these documents.
function parseHtml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
  return doc.querySelector("parsererror") ? new DOMParser().parseFromString(text, "text/html") : doc;
}

function paragraphsOf(doc) {
  const body = doc.querySelector("body") || doc.documentElement;
  let paras = [...body.querySelectorAll(BLOCKS)]
    .filter((el) => !el.querySelector(BLOCKS))
    .map((el) => clean(el.textContent))
    .filter(Boolean);
  if (!paras.length) paras = String(body.textContent || "").split(/\n\s*\n/).map(clean).filter(Boolean);
  return paras;
}

// { title, lang, chapters: [{ title, paragraphs }] } in reading order.
export async function parseEpub(buf) {
  const zip = readZip(buf);
  if (!zip.has("META-INF/container.xml")) throw new Error("not-epub");
  const container = parseXml(await zip.text("META-INF/container.xml"));
  const opfPath = container.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath || !zip.has(opfPath)) throw new Error("not-epub");
  const opf = parseXml(await zip.text(opfPath));
  const meta = (tag) => clean(opf.getElementsByTagNameNS("*", tag)[0]?.textContent);
  const manifest = new Map(
    [...opf.getElementsByTagNameNS("*", "item")].map((it) => [
      it.getAttribute("id"),
      { href: it.getAttribute("href") || "", type: it.getAttribute("media-type") || "", props: it.getAttribute("properties") || "" },
    ])
  );
  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS("*", "itemref")) {
    if (ref.getAttribute("linear") === "no") continue;
    const item = manifest.get(ref.getAttribute("idref"));
    if (!item || !/html/.test(item.type) || /\bnav\b/.test(item.props)) continue;
    const path = resolvePath(opfPath, item.href);
    if (!zip.has(path)) continue;
    const doc = parseHtml(await zip.text(path));
    const paragraphs = paragraphsOf(doc);
    if (!paragraphs.length) continue;
    const title = clean(doc.querySelector("h1, h2, h3")?.textContent) || clean(doc.querySelector("title")?.textContent);
    chapters.push({ title: title.slice(0, 120), paragraphs });
  }
  return { title: meta("title").slice(0, 120), lang: meta("language"), chapters };
}

// Plain text: UTF-8, or Windows-1251 for older Russian-era files.
export function decodeText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1251").decode(buf);
  }
}

// Splits at chapter headings ("Capítulo 2", "Chapter 3", "第三章"…). Text before the first heading is kept.
export function splitText(text) {
  const chapters = [];
  let cur = null;
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const tline = line.trim();
    if (tline && tline.length < 80 && isChapterHeading(tline)) {
      cur = { title: tline, lines: [line] };
      chapters.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: "", lines: [] };
      chapters.push(cur);
    }
    cur.lines.push(line);
  }
  return chapters.map((c) => ({ title: c.title.slice(0, 120), text: c.lines.join("\n") })).filter((c) => c.text.trim());
}
