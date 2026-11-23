/**
 * lib/taste.ts
 *
 * Preference learning from real use. Each Groove take a person leaves is one
 * example: what it was (family, tempo, key, the four sliders) and what they did
 * with it (exported it, kept working on it, or skipped it). From those, Randomise
 * learns which families and settings this person keeps, and leans towards them,
 * while still trying the others now and then.
 *
 * Everything stays on the device. Nothing is recorded unless the person turns it on.
 *
 * The model is deliberately small, so it can be checked and explained:
 *  - per family, a Beta posterior over the keep rate (Thompson sampling picks one);
 *  - per setting, a weighted mean and spread of what was kept in that family.
 * `evaluate` scores it on the most recent takes, held out of training, against
 * a baseline that predicts everyone's overall keep rate.
 */

import type { FamilyId } from "../types";

export type Outcome = "export" | "keep" | "skip";

export interface TakeFeatures {
  family:    FamilyId;
  tempo:     number;
  root:      number;
  energy:    number;
  valence:   number;
  density:   number;
  variation: number;
}

export interface TasteEvent extends TakeFeatures {
  at:      number;   // ms since epoch
  heard:   number;   // seconds played
  outcome: Outcome;
}

/** Below this, the person didn't really hear the take, so it says nothing. */
export const MIN_HEARD = 4;
/** Played this long, a take counts as kept even if nothing else was done with it. */
export const KEEP_HEARD = 45;
const STORE = 5000;

/** What leaving a take says, or null when it says nothing. */
export function outcomeOf(take: { heard: number; touched: boolean; exported: boolean }): Outcome | null {
  if (take.exported) return "export";
  if (take.touched || take.heard >= KEEP_HEARD) return "keep";
  if (take.heard < MIN_HEARD) return null;
  return "skip";
}

/** How much a take counts as kept: an export more than a keep. */
const reward = (o: Outcome) => (o === "export" ? 1 : o === "keep" ? 0.75 : 0);

type Numeric = "tempo" | "energy" | "valence" | "density" | "variation";
const NUMERIC: Numeric[] = ["tempo", "energy", "valence", "density", "variation"];

export interface Taste {
  /** Beta(a, b) per family: a counts keeps, b counts skips, both start at 1. */
  families: Partial<Record<FamilyId, { a: number; b: number }>>;
  /** Kept settings per family, as running weighted sums. */
  settings: Partial<Record<FamilyId, Record<Numeric, { w: number; sum: number; sq: number }>>>;
  /** Kept roots per family. */
  roots:    Partial<Record<FamilyId, Record<number, number>>>;
  events:   number;
}

export function emptyTaste(): Taste {
  return { families: {}, settings: {}, roots: {}, events: 0 };
}

export function learn(events: TasteEvent[]): Taste {
  const t = emptyTaste();
  for (const e of events) {
    const r = reward(e.outcome);
    const f = (t.families[e.family] ??= { a: 1, b: 1 });
    f.a += r;
    f.b += 1 - r;
    if (r > 0) {
      const s = (t.settings[e.family] ??= Object.fromEntries(NUMERIC.map((k) => [k, { w: 0, sum: 0, sq: 0 }])) as Record<Numeric, { w: number; sum: number; sq: number }>);
      for (const k of NUMERIC) {
        s[k].w += r;
        s[k].sum += r * e[k];
        s[k].sq += r * e[k] * e[k];
      }
      const roots = (t.roots[e.family] ??= {});
      roots[e.root] = (roots[e.root] ?? 0) + r;
    }
    t.events++;
  }
  return t;
}

/** The posterior mean keep rate of a family. */
export function keepRate(t: Taste, family: FamilyId): number {
  const f = t.families[family] ?? { a: 1, b: 1 };
  return f.a / (f.a + f.b);
}

// Beta sampling by two Gamma draws (Marsaglia and Tsang), for Thompson sampling
function gamma(k: number, rnd: () => number): number {
  if (k < 1) return gamma(k + 1, rnd) * Math.pow(rnd(), 1 / k);
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = normal(rnd);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function normal(rnd: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
}
function beta(a: number, b: number, rnd: () => number): number {
  const x = gamma(a, rnd);
  return x / (x + gamma(b, rnd));
}

/** Share of picks made at random whatever was learned, so a taste never closes in on itself. */
export const EXPLORE = 0.2;

/**
 * Pick a family: draw a plausible keep rate for each and take the highest. Families
 * with few takes have wide posteriors, so they still come up; ones that keep being
 * skipped fade. With nothing learned, every family is equally likely.
 */
export function pickFamily(t: Taste, options: FamilyId[], rnd: () => number = Math.random): FamilyId {
  if (rnd() < EXPLORE) return options[Math.floor(rnd() * options.length)];
  let best = options[0];
  let top = -1;
  for (const id of options) {
    const f = t.families[id] ?? { a: 1, b: 1 };
    const x = beta(f.a, f.b, rnd);
    if (x > top) { top = x; best = id; }
  }
  return best;
}

/** How much a family's kept settings steer a draw: none at first, at most 70%. */
export function settingsPull(t: Taste, family: FamilyId): number {
  const w = t.settings[family]?.tempo.w ?? 0;
  return Math.min(0.7, w / (w + 4));
}

/**
 * Draw a setting inside its range. With enough keeps in the family, it is drawn
 * near what was kept, by the kept spread; otherwise anywhere in the range.
 */
export function drawSetting(t: Taste, family: FamilyId, key: Numeric, lo: number, hi: number, rnd: () => number = Math.random): number {
  const s = t.settings[family]?.[key];
  const uniform = lo + rnd() * (hi - lo);
  if (!s || rnd() >= settingsPull(t, family)) return uniform;
  const mean = s.sum / s.w;
  const spread = Math.max((hi - lo) * 0.08, Math.sqrt(Math.max(0, s.sq / s.w - mean * mean)));
  return Math.min(hi, Math.max(lo, mean + spread * normal(rnd)));
}

/** Pick a root from the family's keys, leaning to the ones kept. */
export function drawRoot(t: Taste, family: FamilyId, keys: number[], rnd: () => number = Math.random): number {
  const kept = t.roots[family] ?? {};
  const weights = keys.map((k) => 1 + 2 * (kept[k] ?? 0));
  let x = rnd() * weights.reduce((a, b) => a + b, 0);
  for (const [i, w] of weights.entries()) {
    if ((x -= w) < 0) return keys[i];
  }
  return keys[keys.length - 1];
}

/** The model's estimate that a take with these settings is kept. */
export function predict(t: Taste, e: TakeFeatures): number {
  const family = keepRate(t, e.family);
  const s = t.settings[e.family];
  if (!s || s.tempo.w < 2) return family;
  // closer to what was kept in this family, a little more likely; further, less
  let z = 0;
  for (const k of NUMERIC) {
    const mean = s[k].sum / s[k].w;
    const sd = Math.max(k === "tempo" ? 1.5 : 0.05, Math.sqrt(Math.max(0, s[k].sq / s[k].w - mean * mean)));
    z += ((e[k] - mean) / sd) ** 2;
  }
  const near = Math.exp(-z / (2 * NUMERIC.length)); // 1 at the kept centre
  const pull = settingsPull(t, e.family);
  return Math.min(0.99, Math.max(0.01, family * (1 - pull / 2 + pull * near)));
}

export interface Evaluation {
  train:    number;
  test:     number;
  /** Log loss on the held-out takes, lower is better. */
  model:    number;
  baseline: number;
  /** Area under the ROC curve on the held-out takes: 0.5 is chance. */
  auc:      number;
  /** Is there enough to say anything? */
  enough:   boolean;
}

const MIN_TEST = 15;

/**
 * Train on the earlier takes, test on the latest ones. The split is by time, not at
 * random, so the model is only ever scored on takes made after the ones it learned from.
 */
export function evaluate(events: TasteEvent[], testShare = 0.3): Evaluation {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const cut = Math.floor(sorted.length * (1 - testShare));
  const train = sorted.slice(0, cut);
  const test = sorted.slice(cut);
  const taste = learn(train);
  const kept = (e: TasteEvent) => (e.outcome === "skip" ? 0 : 1);
  const base = Math.min(0.99, Math.max(0.01, (train.filter((e) => kept(e)).length + 1) / (train.length + 2)));
  const loss = (p: number, y: number) => -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  const preds = test.map((e) => ({ p: predict(taste, e), y: kept(e) }));
  const n = Math.max(1, test.length);
  return {
    train: train.length,
    test: test.length,
    model: preds.reduce((s, x) => s + loss(x.p, x.y), 0) / n,
    baseline: test.reduce((s, e) => s + loss(base, kept(e)), 0) / n,
    auc: auc(preds),
    enough: test.length >= MIN_TEST && preds.some((x) => x.y === 1) && preds.some((x) => x.y === 0),
  };
}

function auc(preds: { p: number; y: number }[]): number {
  const pos = preds.filter((x) => x.y === 1);
  const neg = preds.filter((x) => x.y === 0);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// --- on-device storage ---

const KEY = "soundxai.taste.v1";

interface Stored { on: boolean; events: TasteEvent[] }

export function loadTaste(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Stored | null;
    if (raw && typeof raw.on === "boolean" && Array.isArray(raw.events)) return raw;
  } catch { /* private window or bad data: start over */ }
  return { on: false, events: [] };
}

export function saveTaste(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ on: s.on, events: s.events.slice(-STORE) }));
  } catch { /* storage full or blocked: learning just stops */ }
}
