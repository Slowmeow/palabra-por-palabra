// Spaced repetition. The answer in review is the same 5→1 level as in the reader:
// 5 and 4 mean "forgot" and start over, 3–1 push the next review further away.
import { t } from "./i18n.js";

const MIN = 60e3;
const DAY = 864e5;
const BASE = { 3: 2, 2: 4, 1: 8 };
const GROW = { 3: 1.4, 2: 2.2, 1: 3 };

export function schedule(prev, level, now = Date.now()) {
  const p = prev || {};
  let reps = p.reps || 0;
  let lapses = p.lapses || 0;
  let ivl;
  if (level >= 4) {
    if (reps > 0) lapses++;
    reps = 0;
    ivl = level === 5 ? 0 : 1;
  } else {
    ivl = reps > 0 && p.ivl ? Math.max(BASE[level], Math.round(p.ivl * GROW[level])) : BASE[level];
    reps++;
  }
  ivl = Math.min(ivl, 365);
  return {
    reps,
    lapses,
    ivl,
    due: new Date(now + (ivl ? ivl * DAY : MIN)).toISOString(),
    last: new Date(now).toISOString(),
  };
}

// Short label for a rating button: "now", "4d", "2mo".
export function ivlLabel(days) {
  if (!days) return t("ivl.now");
  if (days < 30) return t("ivl.d", { n: days });
  if (days < 365) return t("ivl.mo", { n: Math.round(days / 30) });
  return t("ivl.y", { n: Math.round(days / 365) });
}
