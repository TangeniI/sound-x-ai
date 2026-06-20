/**
 * lib/generative-engine.ts
 *
 * In-house techno generation engine. Instant, deterministic-ish, zero
 * network dependencies. The thing that makes it sound like *music* rather
 * than noise is that it works the way techno actually works:
 *
 *   • PATTERNS, NOT PER-STEP RANDOMNESS
 *     One bass loop, one stab loop and one lead riff are generated once,
 *     then repeated across the arrangement with light mutation. Repetition
 *     is what makes techno hypnotic.
 *
 *   • A REAL RHYTHM SECTION
 *     Four-on-the-floor kick, offbeat open hats, clap on 2 & 4, 16th-note
 *     closed hats — programmed, not sampled.
 *
 *   • A DRIVING BASSLINE
 *     Roots/fifths/octaves placed *between* the kicks for the pumping feel,
 *     or a 303-style acid line, depending on the style preset.
 *
 *   • AN ARRANGEMENT
 *     A per-bar layer map (drive → full → breakdown → build → drop) gates
 *     which elements play, so a generated track has a journey.
 *
 *   • A MARKOV RIFF
 *     The lead motif is sampled from a transition matrix trained on a
 *     corpus of motifs, then looped — a riff, not a stream of notes.
 *
 * Conditioned by an AudioFeatures vector from the controls or from an
 * analysed upload (which carries tempo + detected key + energy through).
 */

import type { AudioFeatures, GeneratorConfig, NoteEvent, StyleId } from "../types";

export type StatusCallback = (msg: string) => void;

/* ───────────────────────── music theory ──────────────────────────── */

const SCALES = {
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  "natural-minor": [0, 2, 3, 5, 7, 8, 10],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  major:         [0, 2, 4, 5, 7, 9, 11],
} as const;

function scaleFor(valence: number, mode?: "major" | "minor"): readonly number[] {
  if (mode === "major") return SCALES.major;
  if (mode === "minor") return SCALES["natural-minor"];
  if (valence < 0.3) return SCALES.phrygian;
  if (valence < 0.62) return SCALES["natural-minor"];
  if (valence < 0.82) return SCALES.dorian;
  return SCALES.major;
}

function degToMidi(degree: number, scale: readonly number[], root: number): number {
  const len = scale.length;
  const oct = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return root + oct * 12 + scale[idx];
}

/* ───────────────────── Markov riff model ─────────────────────────── */

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
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/* ──────────────────────── style presets ──────────────────────────── */

interface Style {
  bass: "rolling" | "offbeat" | "acid";
  hats: "offbeat" | "sixteenth";
  stab: boolean;
  pad: boolean;
  lead: "riff" | "minimal" | "acid" | "melodic";
}

const STYLES: Record<StyleId, Style> = {
  driving:  { bass: "rolling",  hats: "sixteenth", stab: true,  pad: false, lead: "riff" },
  hypnotic: { bass: "offbeat",  hats: "offbeat",   stab: true,  pad: false, lead: "minimal" },
  acid:     { bass: "acid",     hats: "sixteenth", stab: false, pad: false, lead: "acid" },
  melodic:  { bass: "offbeat",  hats: "sixteenth", stab: false, pad: true,  lead: "melodic" },
};

/* ────────────────────────── arrangement ──────────────────────────── */

interface Layers { kick: boolean; bass: boolean; stab: boolean; lead: boolean; pad: boolean; hatsFull: boolean; fill: boolean; }

function layersAt(bar: number): Layers {
  const p = bar % 8;
  const breakdown = p === 6;
  const build = p === 7;
  return {
    kick: !breakdown,
    bass: !breakdown,
    stab: p >= 2 && !breakdown,
    lead: p >= 2 || breakdown,
    pad: true,
    hatsFull: !breakdown,
    fill: build,
  };
}

/* ─────────────────────────── engine ──────────────────────────────── */

const SPB = 16; // steps per bar

export class GenerativeEngine {
  generate(cfg: GeneratorConfig, feat: AudioFeatures | null, onStatus: StatusCallback = () => {}): NoteEvent[] {
    const seeded = cfg.seedFromAudio && feat ? feat : null;
    const bpm = Math.round(seeded ? seeded.tempo : cfg.tempo);
    const energy = seeded ? seeded.energy : cfg.energy;
    const density = seeded ? seeded.danceability : cfg.density;
    const valence = seeded ? seeded.valence : cfg.valence;
    const root = seeded?.rootPitch ?? cfg.rootPitch;
    const scale = scaleFor(valence, seeded?.mode);
    const style = STYLES[cfg.style];

    const seed = Math.floor((energy * 1009 + valence * 7919 + density * 631 + bpm * 13 + root * 53) % 2 ** 31);
    const rng = makeRng(seed);

    const stepSec = 60 / bpm / 4;
    const bars = cfg.bars;

    onStatus(`[STYLE] ${cfg.style.toUpperCase()} · ${bpm} BPM · ${bars} bars`);
    if (seeded) onStatus(`[SEED] key + tempo locked to ${seeded.source ?? "upload"}`);

    // generate the looping patterns ONCE
    onStatus("[RIFF] sampling Markov motif…");
    const bassRoot = 28 + root;  // ~E1
    const midRoot = 48 + root;   // ~C3
    const leadRoot = 60 + root;  // ~C4

    const bassPat = buildBass(style.bass, scale, bassRoot, density, rng);
    const stabPat = buildStab(scale, midRoot, rng);
    const leadPat = buildLead(style.lead, scale, leadRoot, bassRoot, cfg.variation, rng);
    const hatPat = buildHats(style.hats, density);

    onStatus("[ARRANGE] laying drive → full → breakdown → drop…");
    const notes: NoteEvent[] = [];
    // swing: nudge the odd 16ths late for groove (kept off the on-grid kick steps)
    const swing = stepSec * (0.1 + cfg.density * 0.14);
    const T = (bar: number, step: number) => (bar * SPB + step) * stepSec + (step % 2 === 1 ? swing : 0);

    for (let bar = 0; bar < bars; bar++) {
      const L = layersAt(bar);
      const mutate = () => rng() < cfg.variation * 0.5;

      for (let s = 0; s < SPB; s++) {
        // ── drums ──
        if (L.kick && s % 4 === 0) notes.push(drum(36, T(bar, s), stepSec, 118));
        if (L.kick && (s === 4 || s === 12)) notes.push(drum(38, T(bar, s), stepSec, 96)); // clap
        if (L.hatsFull && hatPat.closed[s]) notes.push(drum(42, T(bar, s), stepSec, 44 + (s % 4 === 2 ? 12 : 0)));
        if (L.hatsFull && hatPat.open[s]) notes.push(drum(46, T(bar, s), stepSec, 62));
        if (L.fill && s >= 8) notes.push(drum(38, T(bar, s), stepSec * 0.5, 60 + s * 2)); // build roll

        // ── bass ── (skip the exact kick downbeat in rolling mode for pump)
        if (L.bass) {
          const b = bassPat[s];
          if (b !== null && !(style.bass === "rolling" && s % 4 === 0)) {
            notes.push({ pitch: b, startTime: T(bar, s), endTime: T(bar, s) + stepSec * 0.92, velocity: 96, instrument: "bass" });
          }
        }

        // ── stab ──
        if (L.stab && style.stab && stabPat[s]) {
          for (const p of stabPat[s]!) notes.push({ pitch: p, startTime: T(bar, s), endTime: T(bar, s) + stepSec * 1.4, velocity: 70, instrument: "stab" });
        }

        // ── lead riff ──
        if (L.lead) {
          let lp = leadPat[s];
          if (lp !== null && mutate()) lp = degToMidi(nextDeg(0, cfg.variation, rng) + 7, scale, leadRoot);
          if (lp !== null) notes.push({ pitch: lp, startTime: T(bar, s), endTime: T(bar, s) + stepSec * (style.lead === "melodic" ? 2.5 : 1.3), velocity: L.kick ? 78 : 90, instrument: "lead" });
        }

        // ── pad (melodic style only, sustained per bar) ──
        if (L.pad && style.pad && s === 0) {
          for (const off of [0, 2, 4]) notes.push({ pitch: degToMidi(off, scale, midRoot), startTime: T(bar, 0), endTime: T(bar, 0) + stepSec * SPB * 0.98, velocity: 40, instrument: "stab" });
        }
      }

      // ── transition FX (pitch 1 = riser, pitch 2 = impact) ──
      if (L.fill) {
        notes.push({ pitch: 1, startTime: bar * SPB * stepSec, endTime: (bar + 1) * SPB * stepSec, velocity: 90, instrument: "fx" });
      }
      if (bar % 8 === 0 && bar > 0) {
        notes.push({ pitch: 2, startTime: bar * SPB * stepSec, endTime: bar * SPB * stepSec + stepSec * 4, velocity: 115, instrument: "fx" });
      }
    }

    onStatus(`[DONE] ${notes.length} events · bass + drums + stab + lead`);
    return notes.sort((a, b) => a.startTime - b.startTime);
  }
}

/* ─────────────────────── pattern builders ────────────────────────── */

function buildBass(mode: Style["bass"], scale: readonly number[], root: number, density: number, rng: () => number): (number | null)[] {
  const pat: (number | null)[] = new Array(SPB).fill(null);
  if (mode === "offbeat") {
    for (const s of [2, 6, 10, 14]) pat[s] = root;
  } else if (mode === "rolling") {
    for (let s = 0; s < SPB; s++) {
      if (rng() < 0.35 + density * 0.45) pat[s] = rng() < 0.85 ? root : root + 12;
    }
    pat[0] = root; // anchor
  } else { // acid — 303-style line
    let deg = 0;
    for (let s = 0; s < SPB; s++) {
      if (s % 2 === 0 || rng() < 0.4 + density * 0.4) {
        deg = [0, 0, 2, -3, 0, 4, 0, 6][Math.floor(rng() * 8)];
        const oct = rng() < 0.25 ? 12 : 0;
        pat[s] = degToMidi(deg, scale, root) + oct;
      }
    }
    pat[0] = root;
  }
  return pat;
}

function buildStab(scale: readonly number[], root: number, rng: () => number): (number[] | null)[] {
  const pat: (number[] | null)[] = new Array(SPB).fill(null);
  const triad = [0, 2, 4].map((d) => degToMidi(d, scale, root));
  // syncopated offbeat stabs
  const slots = rng() < 0.5 ? [6, 14] : [3, 11];
  for (const s of slots) pat[s] = triad;
  return pat;
}

function buildLead(mode: Style["lead"], scale: readonly number[], leadRoot: number, bassRoot: number, variation: number, rng: () => number): (number | null)[] {
  const pat: (number | null)[] = new Array(SPB).fill(null);
  if (mode === "acid") {
    // mirror an acid bassline up high
    const b = buildBass("acid", scale, bassRoot, 0.7, rng);
    for (let s = 0; s < SPB; s++) pat[s] = b[s] === null ? null : b[s]! + 24;
    return pat;
  }
  const notesPerBar = mode === "minimal" ? 3 : mode === "melodic" ? 7 : 5;
  // place a few onsets, mostly on/around the beat, then walk the Markov chain
  const onsets: number[] = [];
  const candidates = mode === "minimal" ? [0, 6, 10] : [0, 2, 4, 6, 8, 10, 12, 14];
  for (const c of candidates) {
    if (onsets.length >= notesPerBar) break;
    if (c === 0 || rng() < 0.6) onsets.push(c);
  }
  let deg = 0;
  for (const s of onsets) {
    deg = nextDeg(deg, variation * 0.6, rng);
    pat[s] = degToMidi(deg, scale, leadRoot);
  }
  return pat;
}

function buildHats(mode: Style["hats"], density: number): { closed: boolean[]; open: boolean[] } {
  const closed = new Array(SPB).fill(false);
  const open = new Array(SPB).fill(false);
  // signature techno: open hat on the offbeat 8ths
  for (const s of [2, 6, 10, 14]) open[s] = true;
  if (mode === "sixteenth") {
    for (let s = 0; s < SPB; s++) if (!open[s] && (s % 2 === 0 || density > 0.5)) closed[s] = true;
  } else {
    for (const s of [0, 4, 8, 12]) closed[s] = true;
  }
  return { closed, open };
}

function drum(pitch: number, t: number, stepSec: number, velocity: number): NoteEvent {
  return { pitch, startTime: t, endTime: t + stepSec * 0.5, velocity, instrument: "drums" };
}

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
