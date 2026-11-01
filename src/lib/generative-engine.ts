/**
 * lib/generative-engine.ts
 *
 * In-house techno generation engine. Instant, deterministic, zero network
 * dependencies. It works the way techno actually works:
 *
 *   • A TAKE IS A SEED
 *     Same seed + same controls = the same track. Controls shape the take
 *     rather than re-rolling it, so moving a slider changes the music smoothly.
 *     GENERATE draws a new seed; each lane can be re-rolled on its own.
 *
 *   • PATTERNS, NOT PER-STEP RANDOMNESS
 *     One bassline, one stab rhythm and one two-bar riff are written once, then
 *     repeated with light mutation. Repetition is what makes techno hypnotic.
 *
 *   • A REAL RHYTHM SECTION
 *     Four-on-the-floor kick, offbeat open hats, Euclidean percussion, rides
 *     that only arrive at the peak.
 *
 *   • AN ARRANGEMENT
 *     Intro → groove → riff → break → build → drop → outro. Elements enter one
 *     at a time, filters sweep across the build and every riser lands on a drop.
 *
 *   • A LEARNED RIFF
 *     The lead (and the 303 line in ACID) comes from a GRU trained on real MIDI.
 *     A Markov chain over a small motif corpus takes over if the weights fail.
 */

import type {
  AudioFeatures, Automation, GeneratorConfig, Lane, MixParams, NoteEdit, NoteEvent,
  RiffInfo, Section, SectionKind, StyleId, Track,
} from "../types";
import { KITS, RUMBLE_ROOT } from "./audio/kits";
import { neuralRiff } from "./neural-engine";

/* ───────────────────────── music theory ──────────────────────────── */

const SCALES = {
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  "natural-minor": [0, 2, 3, 5, 7, 8, 10],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  major:         [0, 2, 4, 5, 7, 9, 11],
} as const;

function chooseScale(cfg: GeneratorConfig): { scale: readonly number[]; tonality: "minor" | "major" } {
  if (cfg.mode === "major") return { scale: SCALES.major, tonality: "major" };
  if (cfg.mode === "auto" && cfg.valence >= 0.82) return { scale: SCALES.major, tonality: "major" };
  if (cfg.valence < 0.3) return { scale: SCALES.phrygian, tonality: "minor" };
  if (cfg.valence < 0.62) return { scale: SCALES["natural-minor"], tonality: "minor" };
  return { scale: SCALES.dorian, tonality: "minor" };
}

function degToMidi(degree: number, scale: readonly number[], root: number): number {
  const len = scale.length;
  const oct = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return root + oct * 12 + scale[idx];
}

/** Fold a pitch into a register by octaves. */
function fold(pitch: number, lo: number, hi: number): number {
  let p = pitch;
  while (p > hi) p -= 12;
  while (p < lo) p += 12;
  return p;
}

/* ───────────────────── Markov riff fallback ──────────────────────── */

const MOTIFS: number[][] = [
  [0, 0, 3, 2, 0, -2, 0, 0],
  [0, 2, 3, 2, 0, 3, 2, 0],
  [4, 3, 2, 0, 4, 3, 2, 0],
  [0, 0, -3, 0, 2, 0, 3, 2],
  [7, 5, 4, 2, 0, 2, 4, 5],
  [0, 3, 7, 3, 0, 3, 5, 3],
];

type Table = Map<number, Map<number, number>>;
function train(corpus: number[][]): Table {
  const t: Table = new Map();
  for (const m of corpus)
    for (let i = 0; i < m.length - 1; i++) {
      const [a, b] = [m[i], m[i + 1]];
      if (!t.has(a)) t.set(a, new Map());
      const row = t.get(a)!;
      row.set(b, (row.get(b) ?? 0) + 1);
    }
  return t;
}
const TRANS = train(MOTIFS);
const DEGREES = [...new Set(MOTIFS.flat())].sort((a, b) => a - b);

function nextDeg(from: number, temp: number, rng: () => number): number {
  const row = TRANS.get(from);
  const total = row ? [...row.values()].reduce((a, b) => a + b, 0) : 0;
  const weights = DEGREES.map((d) => {
    const p = total ? (row!.get(d) ?? 0) / total : 0;
    return { d, w: (1 - temp) * p + temp / DEGREES.length };
  });
  const sum = weights.reduce((a, b) => a + b.w, 0);
  let r = rng() * sum;
  for (const { d, w } of weights) {
    r -= w;
    if (r <= 0) return d;
  }
  return from;
}

function markovRiff(variation: number, rng: () => number): (number | null)[] {
  const out: (number | null)[] = new Array(RIFF_STEPS).fill(null);
  let deg = 0;
  for (let s = 0; s < RIFF_STEPS; s += 2) {
    if (s % 16 === 0 || rng() < 0.55) {
      deg = nextDeg(deg, variation * 0.6, rng);
      out[s] = deg;
    }
  }
  return out;
}

/* ───────────────────────── utilities ─────────────────────────────── */

function makeRng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each lane gets its own stream, so re-rolling one leaves the others alone. */
function laneRng(cfg: GeneratorConfig, lane: Lane | "hats"): () => number {
  let h = (cfg.seed ^ 0x811c9dc5) >>> 0;
  const salt = `${lane}:${lane === "hats" ? cfg.laneSeeds.drums ?? 0 : cfg.laneSeeds[lane] ?? 0}`;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619);
  return makeRng(h >>> 0);
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const pick = <T,>(items: readonly T[], rng: () => number): T => items[Math.floor(rng() * items.length) % items.length];

/** Bjorklund's Euclidean rhythm: `hits` spread as evenly as possible over `steps`. */
export function euclid(hits: number, steps: number, rotate = 0): boolean[] {
  const out: boolean[] = new Array(steps).fill(false);
  for (let i = 0; i < hits; i++) out[(Math.floor((i * steps) / hits) + rotate) % steps] = true;
  return out;
}

/* ──────────────────────── style definitions ──────────────────────── */

interface Style {
  bass:      "rolling" | "offbeat" | "acid" | "dub" | "sub";
  openHats:  number[];   // steps with an open hat
  swing:     number;     // share of a 16th the off-steps fall late
  stabs:     number[][]; // rhythms to choose from
  stabLen:   number;     // in steps
  chords:    number[];   // chord root, as a scale degree, for each bar of 8
  leadKeep:  number;     // share of the riff's notes the lead plays
  leadLen:   number;     // in steps
  pump:      number;
  space:     number;
  echo:      number;
  rumble:    number;
}

const STYLES: Record<StyleId, Style> = {
  driving: {
    bass: "rolling", openHats: [2, 6, 10, 14], swing: 0.05,
    stabs: [[3, 6, 11, 14], [0, 6, 12], [3, 6, 10, 14]], stabLen: 2,
    chords: [0, 0, 0, 0, 0, 0, 6, 6], leadKeep: 0.8, leadLen: 1.2, pump: 0.8, space: 0.3, echo: 0.3, rumble: 0.8,
  },
  hypnotic: {
    bass: "offbeat", openHats: [2, 6, 10, 14], swing: 0.12,
    stabs: [[3, 11], [6, 14], [3, 10]], stabLen: 3,
    chords: [0, 0, 0, 0, 0, 0, 0, 0], leadKeep: 0.45, leadLen: 1.4, pump: 0.62, space: 0.45, echo: 0.55, rumble: 0.65,
  },
  acid: {
    bass: "acid", openHats: [2, 6, 10, 14], swing: 0.08,
    stabs: [[6, 14]], stabLen: 2,
    chords: [0, 0, 0, 0, 0, 0, 0, 0], leadKeep: 0.3, leadLen: 1.2, pump: 0.7, space: 0.3, echo: 0.42, rumble: 0.6,
  },
  melodic: {
    bass: "offbeat", openHats: [2, 6, 10, 14], swing: 0.06,
    stabs: [[0, 6, 12], [3, 8, 14]], stabLen: 5,
    chords: [0, 0, 5, 5, 2, 2, 6, 6], leadKeep: 0.8, leadLen: 2.4, pump: 0.72, space: 0.58, echo: 0.45, rumble: 0.45,
  },
  dub: {
    bass: "dub", openHats: [14], swing: 0.14,
    stabs: [[3], [6], [3, 11], [14]], stabLen: 3,
    chords: [0, 0, 0, 0, 0, 0, 0, 3], leadKeep: 0.28, leadLen: 1.6, pump: 0.5, space: 0.62, echo: 0.9, rumble: 0.55,
  },
  warehouse: {
    bass: "sub", openHats: [2, 10], swing: 0.03,
    stabs: [[0], [6], [0, 10]], stabLen: 2,
    chords: [0, 0, 0, 0, 0, 0, 1, 1], leadKeep: 0.3, leadLen: 1.1, pump: 0.9, space: 0.42, echo: 0.28, rumble: 1,
  },
};

/* ────────────────────────── arrangement ──────────────────────────── */

export const LENGTHS = [16, 32, 64, 96, 128];

const LAYOUTS: Record<number, [SectionKind, number][]> = {
  16: [["intro", 4], ["groove", 4], ["break", 2], ["build", 2], ["drop", 4]],
  32: [["intro", 4], ["groove", 8], ["break", 4], ["build", 4], ["drop", 8], ["outro", 4]],
  64: [["intro", 8], ["groove", 8], ["riff", 8], ["break", 8], ["build", 8], ["drop", 16], ["outro", 8]],
  96: [["intro", 8], ["groove", 16], ["riff", 16], ["break", 8], ["build", 8], ["drop", 24], ["outro", 16]],
  128: [["intro", 16], ["groove", 16], ["riff", 24], ["break", 16], ["build", 8], ["drop", 32], ["outro", 16]],
};

export function arrange(bars: number): Section[] {
  const nearest = LENGTHS.reduce((a, b) => (Math.abs(b - bars) < Math.abs(a - bars) ? b : a));
  let at = 0;
  return LAYOUTS[nearest].map(([kind, length]) => {
    const s = { kind, startBar: at, bars: length };
    at += length;
    return s;
  });
}

interface Layers { kick: boolean; clap: number; hats: number; ride: boolean; perc: number; bass: boolean; stab: boolean; lead: number; pad: boolean }

const LAYERS: Record<SectionKind, Layers> = {
  intro:  { kick: true,  clap: 0, hats: 0.5, ride: false, perc: 0.3, bass: false, stab: false, lead: 0,    pad: false },
  groove: { kick: true,  clap: 1, hats: 0.8, ride: false, perc: 0.6, bass: true,  stab: true,  lead: 0.45, pad: false },
  riff:   { kick: true,  clap: 1, hats: 1,   ride: false, perc: 1,   bass: true,  stab: true,  lead: 0.75, pad: false },
  break:  { kick: false, clap: 0, hats: 0.2, ride: false, perc: 0.4, bass: false, stab: true,  lead: 1,    pad: true  },
  build:  { kick: true,  clap: 0, hats: 0.7, ride: false, perc: 0.6, bass: false, stab: true,  lead: 0.6,  pad: true  },
  drop:   { kick: true,  clap: 1, hats: 1,   ride: true,  perc: 1,   bass: true,  stab: true,  lead: 1,    pad: false },
  outro:  { kick: true,  clap: 1, hats: 0.7, ride: false, perc: 0.4, bass: true,  stab: false, lead: 0,    pad: false },
};

/* ─────────────────────────── engine ──────────────────────────────── */

const SPB = 16;         // steps per bar
const RIFF_STEPS = 32;  // two bars

export class GenerativeEngine {
  generate(cfg: GeneratorConfig, edits: NoteEdit[] = []): Track {
    const style = STYLES[cfg.style];
    const { scale, tonality } = chooseScale(cfg);
    const root = cfg.rootPitch;
    const stepSec = 60 / cfg.tempo / 4;
    const swing = stepSec * (style.swing + cfg.density * 0.05);
    const time = (step: number) => step * stepSec + (step % 2 === 1 ? swing : 0);

    const sections = arrange(cfg.bars);
    const bars = sections.reduce((n, s) => n + s.bars, 0);
    const notes: NoteEvent[] = [];
    const riff = writeRiff(cfg);

    const ctx: WriteContext = { cfg, style, scale, root, bars, sections, notes, time, stepSec, riff: riff.degrees };
    writeDrums(ctx);
    writePerc(ctx);
    writeBass(ctx);
    writeChords(ctx);
    writeLead(ctx);
    writeFx(ctx);

    const mix = mixFor(cfg, style);
    const final = applyEdits(notes, edits, time, stepSec).sort((a, b) => a.startTime - b.startTime);
    return {
      config: cfg,
      notes: final,
      sections,
      automation: automationFor(sections, stepSec, mix),
      bpm: cfg.tempo,
      stepSec,
      durationSec: bars * SPB * stepSec,
      root,
      tonality,
      scale,
      mix,
      riff: riff.info,
    };
  }
}

interface WriteContext {
  cfg: GeneratorConfig;
  style: Style;
  scale: readonly number[];
  root: number;
  bars: number;
  sections: Section[];
  notes: NoteEvent[];
  time: (step: number) => number;
  stepSec: number;
  riff: (number | null)[];
}

function sectionAt(sections: Section[], bar: number): Section {
  return sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars) ?? sections[sections.length - 1];
}

function note(c: WriteContext, instrument: NoteEvent["instrument"], step: number, pitch: number, length: number, velocity: number, extra: Partial<NoteEvent> = {}): void {
  const start = c.time(step);
  c.notes.push({ pitch, step, startTime: start, endTime: start + length * c.stepSec, velocity: Math.round(clamp(velocity, 1, 127)), instrument, ...extra });
}

/** Energy lifts every hit a little, so the whole mix leans in or backs off. */
const vel = (c: WriteContext, base: number) => base * (0.7 + c.cfg.energy * 0.42);

/** The chord root under a bar, as a scale degree. */
function chordAt(c: WriteContext, bar: number): number {
  return c.style.chords[bar % c.style.chords.length];
}

/** Stacked thirds from the scale, as semitones above the chord root. */
function chordShape(c: WriteContext, degree: number): number[] {
  const base = degToMidi(degree, c.scale, 0);
  return [0, 2, 4, 6].map((d) => degToMidi(degree + d, c.scale, 0) - base);
}

/* ────────────────────────── the riff ─────────────────────────────── */

let lastRiff: { key: string; value: { degrees: (number | null)[]; info: RiffInfo } } | null = null;

function writeRiff(cfg: GeneratorConfig): { degrees: (number | null)[]; info: RiffInfo } {
  const rng = laneRng(cfg, "lead");
  const temperature = 0.6 + cfg.variation * 0.6;
  if (neuralRiff.ready) {
    // moving most sliders doesn't touch the riff, so don't re-run the network
    const key = JSON.stringify([cfg.seed, cfg.laneSeeds.lead ?? 0, temperature, cfg.pins]);
    if (lastRiff?.key === key) return lastRiff.value;
    const s = neuralRiff.sample(RIFF_STEPS, temperature, rng, cfg.pins);
    const value = {
      degrees: s.degrees,
      info: { neural: true, tokens: s.tokens, vocab: neuralRiff.vocab, probs: s.probs, temperature },
    };
    lastRiff = { key, value };
    return value;
  }
  const degrees = markovRiff(cfg.variation, rng);
  return { degrees, info: { neural: false, tokens: [], vocab: [], probs: [], temperature } };
}

/* ──────────────────────────── drums ──────────────────────────────── */

function writeDrums(c: WriteContext): void {
  const { cfg, style } = c;
  const hatRng = laneRng(cfg, "hats");
  const roll = laneRng(cfg, "drums");
  const hatGate = Array.from({ length: SPB }, (_, s) => (s % 2 === 0 ? 0 : 0.15 + hatRng() * 0.85));
  const swap = roll();     // decides how this take plays its backbeat
  const ghost = roll();

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    const L = LAYERS[sec.kind];
    const fromEnd = sec.startBar + sec.bars - 1 - bar;
    const isBuild = sec.kind === "build";
    const beforeDrop = isBuild && fromEnd === 0;
    const phraseEnd = (bar + 1) % 8 === 0;

    for (let s = 0; s < SPB; s++) {
      const step = bar * SPB + s;
      const beat = s % 4 === 0;

      // the last beats before the drop pull the floor away
      const silent = beforeDrop && s >= 12;
      if (L.kick && beat && !silent && !(phraseEnd && s === 12 && sec.kind === "groove")) {
        note(c, "drums", step, 36, 2, vel(c, 122));
      }
      if (L.kick && cfg.energy > 0.72 && sec.kind === "drop" && s === 15 && ghost < 0.6 && bar % 2 === 1) {
        note(c, "drums", step, 36, 1, vel(c, 84));
      }

      if (L.clap && (s === 4 || s === 12)) {
        const useRim = cfg.style === "dub" || (cfg.style === "hypnotic" && sec.kind !== "drop" && swap < 0.6);
        note(c, "drums", step, useRim ? 37 : 39, 1, vel(c, 104));
      }
      if (cfg.style === "dub" && L.clap && s === 7 && bar % 2 === 1) note(c, "drums", step, 37, 1, vel(c, 70));

      if (!silent && L.hats > 0) {
        const hatDensity = L.hats * (0.25 + cfg.density * 0.75);
        const open = style.openHats.includes(s);
        if (open && (L.hats >= 0.5 || s === 14)) {
          note(c, "drums", step, 46, 2, vel(c, 78 + (s === 2 ? 8 : 0)));
        } else if (hatGate[s] < hatDensity) {
          note(c, "drums", step, 42, 1, vel(c, 60 + (s % 4 === 2 ? 18 : 0) - (s % 2 === 1 ? 12 : 0)));
        }
      }

      // a ride only arrives at the peak, every second hit lighter
      if (L.ride && cfg.energy > 0.45 && s % 2 === 0) note(c, "drums", step, 51, 2, vel(c, s % 4 === 0 ? 78 : 56));

      // build: a roll that tightens towards the drop
      if (isBuild) {
        const span = sec.bars;
        const progress = 1 - fromEnd / span;
        const every = progress > 0.75 ? 1 : progress > 0.5 ? 2 : 4;
        if (s % every === 0 && !silent) note(c, "drums", step, 39, 1, 48 + progress * 62 + s);
      }
    }
    if (sec.kind === "drop" && bar === sec.startBar) note(c, "drums", bar * SPB, 49, 16, vel(c, 112));
  }
}

function writePerc(c: WriteContext): void {
  const { cfg } = c;
  const rng = laneRng(cfg, "perc");
  const a = euclid(3 + Math.floor(rng() * 3), SPB, Math.floor(rng() * SPB));
  const b = euclid(5 + Math.floor(rng() * 3), SPB, 1 + Math.floor(rng() * 7));
  const shakerHits = euclid(11, SPB, Math.floor(rng() * 4));
  const gate = Array.from({ length: SPB * 2 }, () => rng());

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    const L = LAYERS[sec.kind];
    if (L.perc === 0) continue;
    const keep = L.perc * (0.35 + cfg.density * 0.75);
    for (let s = 0; s < SPB; s++) {
      const step = bar * SPB + s;
      const g = gate[(bar % 2) * SPB + s];
      if (a[s] && g < keep) note(c, "perc", step, 56, 1, vel(c, 92 + (s % 3) * 8));
      if (b[s] && g * 1.2 < keep && L.perc >= 0.6) note(c, "perc", step, 60, 1, vel(c, 78));
      if (shakerHits[s] && L.perc >= 0.6 && cfg.energy > 0.35) note(c, "perc", step, 64, 1, vel(c, 58 + (s % 4 === 2 ? 16 : 0)));
    }
  }
}

/* ──────────────────────────── bass ───────────────────────────────── */

interface BassStep { degree: number; length: number; accent?: boolean; slide?: boolean }

function bassPattern(c: WriteContext): (BassStep | null)[] {
  const { cfg, style } = c;
  const rng = laneRng(cfg, "bass");
  const pat: (BassStep | null)[] = new Array(RIFF_STEPS).fill(null);
  const u = Array.from({ length: RIFF_STEPS }, () => rng());
  const v = Array.from({ length: RIFF_STEPS }, () => rng());

  if (style.bass === "acid") {
    // the 303 line is the riff itself, folded down into the bass register
    for (let s = 0; s < RIFF_STEPS; s++) {
      const d = c.riff[s];
      if (d != null) pat[s] = { degree: ((d % 7) + 7) % 7, length: u[s] < 0.3 ? 2 : 0.9, accent: u[s] < 0.2 + cfg.energy * 0.25, slide: v[s] < 0.22 };
      else if (s % 4 === 2 && u[s] < 0.3 + cfg.density * 0.5) pat[s] = { degree: 0, length: 0.9 };
    }
    pat[0] = { degree: 0, length: 0.9, accent: true };
    return pat;
  }
  for (let s = 0; s < RIFF_STEPS; s++) {
    const beat = s % 4 === 0;
    const degree = v[s] < 0.72 ? 0 : v[s] < 0.86 ? 7 : v[s] < 0.94 ? 4 : 2;
    if (style.bass === "rolling") {
      if (!beat && u[s] < 0.42 + cfg.density * 0.5) pat[s] = { degree, length: 0.9 };
    } else if (style.bass === "offbeat") {
      if (s % 4 === 2) pat[s] = { degree: v[s] < 0.8 ? 0 : 7, length: 1.6 };
      else if (s % 4 === 3 && u[s] < cfg.density * 0.5) pat[s] = { degree: 0, length: 0.8 };
    } else if (style.bass === "dub") {
      if (s === 3 || s === 10 || s === 19) pat[s] = { degree: 0, length: 5 };
      else if (s === 27 && u[s] < 0.6) pat[s] = { degree: 4, length: 3 };
    } else if (s === 6 || s === 14 || s === 22 || s === 26 || (s === 30 && u[s] < cfg.density)) {
      pat[s] = { degree: 0, length: 1.4 };
    }
  }
  return pat;
}

function writeBass(c: WriteContext): void {
  const pat = bassPattern(c);
  const base = 28 + c.root;
  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    if (!LAYERS[sec.kind].bass) continue;
    const chord = chordAt(c, bar);
    for (let s = 0; s < SPB; s++) {
      const cell = pat[(bar % 2) * SPB + s];
      if (!cell) continue;
      const pitch = fold(degToMidi(cell.degree + chord, c.scale, base), 26, 50);
      note(c, "bass", bar * SPB + s, pitch, cell.length, vel(c, cell.accent ? 124 : 104 - (s % 4 === 3 ? 14 : 0)), { accent: cell.accent, slide: cell.slide });
    }
  }
}

/* ─────────────────────────── harmony ─────────────────────────────── */

function writeChords(c: WriteContext): void {
  const { cfg, style } = c;
  const rng = laneRng(cfg, "stab");
  const rhythm = pick(style.stabs, rng);
  const second = rng() < cfg.variation ? pick(style.stabs, rng) : rhythm;
  const padRng = laneRng(cfg, "pad");
  const padLift = padRng() < 0.5 ? 0 : 12;

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    const L = LAYERS[sec.kind];
    const degree = chordAt(c, bar);
    const shape = chordShape(c, degree);
    const pitch = fold(degToMidi(degree, c.scale, 48 + c.root), 48, 62);
    const thin = sec.kind === "groove" && (sec.startBar + sec.bars - bar) > sec.bars / 2;

    if (L.stab && !thin && (style.stabs.length > 1 || cfg.style !== "acid")) {
      for (const s of bar % 2 === 0 ? rhythm : second) {
        note(c, "stab", bar * SPB + s, pitch, style.stabLen, vel(c, sec.kind === "break" ? 74 : 92), { chord: shape });
      }
    }
    if (L.pad && bar % 2 === 0 && bar < sec.startBar + sec.bars) {
      const span = Math.min(2, sec.startBar + sec.bars - bar) * SPB;
      note(c, "pad", bar * SPB, pitch + padLift, span, vel(c, 88), { chord: shape });
    }
  }
}

/* ───────────────────────────── lead ──────────────────────────────── */

function writeLead(c: WriteContext): void {
  const { cfg, style, scale } = c;
  const rng = laneRng(cfg, "lead");
  for (let i = 0; i < RIFF_STEPS; i++) rng(); // stay clear of the draws the riff used
  const keep = Array.from({ length: RIFF_STEPS }, () => rng());
  const swap = Array.from({ length: RIFF_STEPS }, () => rng());
  const step2 = Array.from({ length: RIFF_STEPS }, () => (rng() < 0.5 ? -1 : 1));
  const base = 60 + c.root;

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    const presence = LAYERS[sec.kind].lead;
    if (presence === 0) continue;
    const chord = chordAt(c, bar);
    const answering = bar % 8 >= 4; // the second half of a phrase answers the first
    for (let s = 0; s < SPB; s++) {
      const i = (bar % 2) * SPB + s;
      const d = c.riff[i];
      if (d == null || keep[i] > style.leadKeep * presence) continue;
      const degree = answering && swap[i] < cfg.variation * 0.45 ? d + step2[i] : d;
      const pitch = fold(degToMidi(degree + chord, scale, base), 57, 88);
      const sparse = c.riff[(i + 1) % RIFF_STEPS] == null;
      note(c, "lead", bar * SPB + s, pitch, style.leadLen * (sparse ? 1.6 : 1), vel(c, sec.kind === "break" ? 100 : 88));
    }
  }
}

/* ──────────────────────── transitions + mix ──────────────────────── */

function writeFx(c: WriteContext): void {
  const barLen = SPB;
  for (const sec of c.sections) {
    const at = sec.startBar * barLen;
    const length = sec.bars * barLen;
    if (sec.kind === "build") c.notes.push(fxNote(c, 1, at, length));
    if (sec.kind === "drop") c.notes.push(fxNote(c, 2, at, barLen));
    if (sec.kind === "break") c.notes.push(fxNote(c, 3, at, length));
  }
}

function fxNote(c: WriteContext, pitch: number, step: number, length: number): NoteEvent {
  const start = step * c.stepSec;
  return { pitch, step, startTime: start, endTime: start + length * c.stepSec, velocity: 100, instrument: "fx" };
}

function mixFor(cfg: GeneratorConfig, style: Style): MixParams {
  const kit = KITS[cfg.style];
  // tune the kick to the root or fifth, whichever needs the smaller shift
  const tuneTo = (pitch: number) => {
    const shift = (target: number) => ((target - pitch) % 12 + 18) % 12 - 6;
    const [root, fifth] = [shift(cfg.rootPitch), shift(cfg.rootPitch + 7)];
    return Math.abs(root) <= Math.abs(fifth) ? root : fifth;
  };
  return {
    drive: clamp(0.15 + cfg.energy * 0.75),
    rumble: clamp(style.rumble * (0.4 + cfg.energy * 0.75)),
    space: clamp(style.space * (1.15 - cfg.energy * 0.3)),
    echo: clamp(style.echo),
    brightness: clamp(cfg.valence * 0.6 + cfg.energy * 0.3 + 0.1),
    pump: clamp(style.pump * (0.65 + cfg.energy * 0.5)),
    kickTune: tuneTo(kit.kickRoot),
    rumbleTune: tuneTo(RUMBLE_ROOT),
  };
}

function automationFor(sections: Section[], stepSec: number, mix: MixParams): Automation[] {
  const bar = stepSec * SPB;
  const space = 0.2 + mix.space * 0.65;
  const echo = 0.25 + mix.echo * 0.34;
  const out: Automation[] = [
    { time: 0, param: "cutoff", value: 18000, ramp: 0.01 },
    { time: 0, param: "space", value: space, ramp: 0.01 },
    { time: 0, param: "echo", value: echo, ramp: 0.01 },
  ];
  const acidOpen: Record<SectionKind, number> = { intro: 0.2, groove: 0.45, riff: 0.7, break: 0.35, build: 1, drop: 1, outro: 0.5 };
  for (const s of sections) {
    const t = s.startBar * bar;
    const len = s.bars * bar;
    out.push({ time: t, param: "acid", value: acidOpen[s.kind], ramp: 0 });
    if (s.kind === "break") {
      out.push({ time: t, param: "cutoff", value: 750, ramp: bar });
      out.push({ time: t, param: "space", value: Math.min(0.95, space + 0.3), ramp: bar });
      out.push({ time: t, param: "echo", value: Math.min(0.66, echo + 0.2), ramp: bar });
    } else if (s.kind === "build") {
      out.push({ time: t, param: "cutoff", value: 15000, ramp: len });
    } else if (s.kind === "drop") {
      out.push({ time: t, param: "cutoff", value: 18000, ramp: 0.02 });
      out.push({ time: t, param: "space", value: space, ramp: 0.02 });
      out.push({ time: t, param: "echo", value: echo, ramp: 0.02 });
    } else if (s.kind === "outro") {
      out.push({ time: t, param: "cutoff", value: 3200, ramp: len });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ─────────────────────────── edits ───────────────────────────────── */

/** Replay piano-roll edits over freshly written notes. */
export function applyEdits(notes: NoteEvent[], edits: NoteEdit[], time: (step: number) => number, stepSec: number): NoteEvent[] {
  let out = notes;
  for (const e of edits) {
    if (e.op === "remove") {
      out = out.filter((n) => !(n.instrument === e.lane && n.step === e.step && n.pitch === e.pitch));
    } else {
      const start = time(e.step);
      const length = e.lane === "drums" || e.lane === "perc" ? 1 : 1.6;
      out = [...out, { pitch: e.pitch, step: e.step, startTime: start, endTime: start + length * stepSec, velocity: 100, instrument: e.lane }];
    }
  }
  return out;
}

/* ───────────────────────── seeds + DNA ───────────────────────────── */

export function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/** The first track anyone hears, and what a partial link falls back to. */
export const DEFAULT_CONFIG: GeneratorConfig = {
  style: "driving", bars: 32, tempo: 132, energy: 0.72, valence: 0.42, density: 0.65,
  variation: 0.35, rootPitch: 9, mode: "auto", seed: 909, laneSeeds: {}, pins: {},
};

/* visual DNA from the raw controls */
export function featuresFromConfig(cfg: GeneratorConfig): AudioFeatures {
  return {
    tempo: cfg.tempo,
    energy: cfg.energy,
    valence: cfg.valence,
    danceability: cfg.density,
    acousticness: clamp(0.35 - cfg.energy * 0.25),
    brightness: clamp(cfg.valence * 0.6 + 0.2),
    source: "CONTROLS",
  };
}

export const generativeEngine = new GenerativeEngine();
