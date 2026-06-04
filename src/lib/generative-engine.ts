/**
 * lib/generative-engine.ts
 *
 * The in-house generative music engine. Produces a full arrangement
 * (melody + chords + drums) instantly and deterministically-ish, with
 * zero network dependencies — so the demo always works on first click.
 *
 * It is not "random notes". Four real techniques cooperate:
 *
 *   1. MARKOV MELODY MODEL
 *      A first-order transition matrix over scale degrees, *trained* at
 *      module load from a small corpus of idiomatic electronic motifs.
 *      Generation walks the chain; `variation` blends the learned
 *      distribution with a uniform one (temperature).
 *
 *   2. FUNCTIONAL HARMONY
 *      A weighted progression generator that picks chord functions
 *      (tonic / subdominant / dominant) according to a tension value,
 *      and voices them as triads → 7ths → 9ths as tension rises.
 *
 *   3. EUCLIDEAN RHYTHM
 *      Bjorklund's algorithm distributes hat/perc onsets as evenly as
 *      possible across 16 steps; kick/snare follow a four-on-the-floor
 *      backbone whose presence is gated by the tension envelope.
 *
 *   4. TENSION / RELEASE ENVELOPE
 *      A parametric arc over the bars (build → peak → drop → release)
 *      modulates note density, register, chord extensions and drum
 *      fullness — so the track has structure, not just texture.
 *
 * Everything is conditioned by an AudioFeatures "DNA" vector, which can
 * come from the on-screen controls or from analysing an uploaded track.
 */

import type { AudioFeatures, GeneratorConfig, NoteEvent } from "../types";

export type StatusCallback = (msg: string) => void;

/* ───────────────────────── music theory ──────────────────────────── */

/** Scale interval patterns (semitones from root). */
const SCALES = {
  "natural-minor":  [0, 2, 3, 5, 7, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  dorian:           [0, 2, 3, 5, 7, 9, 10],
  major:            [0, 2, 4, 5, 7, 9, 11],
  lydian:           [0, 2, 4, 6, 7, 9, 11],
  phrygian:         [0, 1, 3, 5, 7, 8, 10],
} as const;

/** Pick a scale from valence: low = dark modes, high = bright modes. */
function scaleFromValence(valence: number): keyof typeof SCALES {
  if (valence < 0.18) return "phrygian";
  if (valence < 0.38) return "natural-minor";
  if (valence < 0.52) return "harmonic-minor";
  if (valence < 0.68) return "dorian";
  if (valence < 0.85) return "major";
  return "lydian";
}

/* ───────────────────── Markov melody model ───────────────────────── */

/**
 * Motif corpus — each entry is a sequence of *scale degrees* (0 = root).
 * Negative numbers reach below the root; values > 6 reach the next octave.
 * These encode the idioms the model learns transitions from.
 */
const MOTIF_CORPUS: number[][] = [
  [0, 2, 4, 2, 0, -3, 0, 2],
  [0, 0, 3, 2, 4, 4, 2, 0],
  [4, 3, 2, 1, 0, 2, 4, 7],
  [0, 4, 7, 4, 5, 4, 2, 0],
  [7, 4, 2, 4, 0, 2, 3, 2],
  [0, -3, 0, 2, 4, 5, 4, 2],
  [2, 4, 5, 7, 5, 4, 2, 0],
  [0, 2, 0, 4, 0, 5, 4, 2],
  [4, 4, 5, 4, 2, 0, 2, 3],
  [0, 1, 0, -3, 0, 2, 1, 0],
];

/**
 * Transition matrix: map<fromDegree, map<toDegree, count>>.
 * Built once at module load — this is the "training" step.
 */
type TransitionTable = Map<number, Map<number, number>>;

function trainMarkov(corpus: number[][]): TransitionTable {
  const table: TransitionTable = new Map();
  for (const motif of corpus) {
    for (let i = 0; i < motif.length - 1; i++) {
      const from = motif[i];
      const to = motif[i + 1];
      if (!table.has(from)) table.set(from, new Map());
      const row = table.get(from)!;
      row.set(to, (row.get(to) ?? 0) + 1);
    }
  }
  return table;
}

const TRANSITIONS = trainMarkov(MOTIF_CORPUS);
const ALL_DEGREES = Array.from(
  new Set(MOTIF_CORPUS.flat())
).sort((a, b) => a - b);

/** Sample the next degree, blending the learned row with uniform noise. */
function nextDegree(from: number, temperature: number, rng: () => number): number {
  const row = TRANSITIONS.get(from);
  // weight[d] = (1 - t) * learnedProb + t * uniform
  const weights: { d: number; w: number }[] = ALL_DEGREES.map((d) => {
    const learned = row?.get(d) ?? 0;
    const total = row ? [...row.values()].reduce((a, b) => a + b, 0) : 0;
    const p = total > 0 ? learned / total : 0;
    const uniform = 1 / ALL_DEGREES.length;
    return { d, w: (1 - temperature) * p + temperature * uniform };
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

/** Tiny seeded PRNG (mulberry32) so a given DNA is reproducible-ish. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Map a scale degree (can be <0 or >6) to a MIDI pitch in a given scale. */
function degreeToMidi(degree: number, scale: readonly number[], root: number): number {
  const len = scale.length;
  const octave = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return root + octave * 12 + scale[idx];
}

/**
 * Bjorklund's algorithm — distribute `pulses` onsets across `steps`
 * as evenly as possible. Returns a boolean hit-mask of length `steps`.
 */
function euclid(pulses: number, steps: number): boolean[] {
  pulses = clamp(pulses, 0, steps);
  if (pulses <= 0) return new Array(steps).fill(false);
  if (pulses >= steps) return new Array(steps).fill(true);

  let groups: boolean[][] = [];
  for (let i = 0; i < steps; i++) groups.push([i < pulses]);

  let a = pulses;
  let b = steps - pulses;
  while (b > 1) {
    const count = Math.min(a, b);
    const next: boolean[][] = [];
    for (let i = 0; i < count; i++) next.push([...groups[i], ...groups[groups.length - count + i]]);
    const remainder = groups.slice(count, groups.length - count);
    groups = [...next, ...remainder];
    const newA = count;
    const newB = Math.max(a, b) - count;
    a = Math.min(newA, newB);
    b = Math.max(newA, newB);
    if (a <= 1) break;
  }
  return groups.flat();
}

/* ───────────────────── tension / release envelope ─────────────────── */

/**
 * Tension value (0–1) for a given bar, shaped as a build → peak → drop arc
 * repeating over an 8-bar phrase, with a slow rise across the whole track.
 */
function tensionAt(bar: number, totalBars: number): number {
  const phraseLen = 8;
  const phrasePos = (bar % phraseLen) / phraseLen;          // 0–1 within phrase
  // build to ~0.8 of the phrase, then sharp release
  const phrase = phrasePos < 0.8 ? phrasePos / 0.8 : 1 - (phrasePos - 0.8) / 0.2;
  const global = totalBars > 1 ? bar / (totalBars - 1) : 0; // slow whole-track rise
  return clamp(phrase * 0.7 + global * 0.3);
}

/* ─────────────────────── chord generation ────────────────────────── */

/** Roman-numeral roots (scale-degree index) grouped by harmonic function. */
const FUNCTIONS = {
  tonic:       [0, 5, 2],   // i / vi / iii — rest
  subdominant: [3, 1],      // iv / ii — motion
  dominant:    [4, 6],      // V / vii — tension
} as const;

function pickChordRoot(tension: number, rng: () => number): number {
  // higher tension biases toward dominant function
  const r = rng();
  if (tension > 0.66) return r < 0.7 ? pick(FUNCTIONS.dominant, rng) : pick(FUNCTIONS.subdominant, rng);
  if (tension > 0.33) return r < 0.6 ? pick(FUNCTIONS.subdominant, rng) : pick(FUNCTIONS.tonic, rng);
  return r < 0.7 ? pick(FUNCTIONS.tonic, rng) : pick(FUNCTIONS.subdominant, rng);
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/* ─────────────────────────── engine ──────────────────────────────── */

const STEPS_PER_BAR = 16; // 16th-note grid

export class GenerativeEngine {
  /** Generate a full arrangement from config + optional analysed DNA. */
  generate(
    config: GeneratorConfig,
    features: AudioFeatures | null,
    onStatus: StatusCallback = () => {}
  ): NoteEvent[] {
    // ── resolve the conditioning vector ──────────────────────────────
    const dna: AudioFeatures = config.seedFromAudio && features
      ? features
      : {
          tempo:        config.tempo,
          energy:       config.energy,
          valence:      config.valence,
          danceability: config.density,
          acousticness: 0.2,
        };

    const bpm = Math.round(config.seedFromAudio && features ? features.tempo : config.tempo);
    const scaleId = scaleFromValence(dna.valence);
    const scale = SCALES[scaleId];
    const root = 48 + config.rootPitch; // C3-ish base

    const seed = Math.floor(
      (dna.energy * 1e3 + dna.valence * 1e5 + bpm * 7 + config.rootPitch * 31) % 2 ** 31
    );
    const rng = makeRng(seed || 1);

    onStatus(`[TRAIN] Markov model: ${TRANSITIONS.size} states from ${MOTIF_CORPUS.length} motifs`);
    onStatus(`[KEY] ${scaleId.toUpperCase()} · ${bpm} BPM · ${config.bars} bars`);

    const secPerBeat = 60 / bpm;
    const stepSec = secPerBeat / 4;
    const bars = config.bars;

    const notes: NoteEvent[] = [];

    // ── melody (Markov walk + tension-gated rhythm) ──────────────────
    onStatus("[MELODY] Walking transition chain…");
    let degree = 0;
    for (let bar = 0; bar < bars; bar++) {
      const tension = tensionAt(bar, bars);
      const octaveLift = tension > 0.6 ? 7 : 0; // jump an octave at peaks
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        // onset probability rises with energy + tension; favours on-beats
        const onBeat = step % 4 === 0;
        const onHalf = step % 2 === 0;
        let p = 0.12 + dna.energy * 0.35 + tension * 0.25;
        if (onBeat) p += 0.35;
        else if (onHalf) p += 0.12;
        if (rng() > p) continue;

        degree = nextDegree(degree, config.variation, rng);
        const pitch = degreeToMidi(degree, scale, root + 12 + octaveLift);
        const t = (bar * STEPS_PER_BAR + step) * stepSec;
        const len = (onBeat ? 2 : 1) * stepSec * (0.8 + rng() * 0.4);
        notes.push({
          pitch,
          startTime: t,
          endTime: t + len,
          velocity: Math.round(70 + tension * 35 + (onBeat ? 12 : 0)),
          instrument: "melody",
        });
      }
    }

    // ── chords (functional harmony, one per bar) ─────────────────────
    onStatus("[HARMONY] Generating functional progression…");
    for (let bar = 0; bar < bars; bar++) {
      const tension = tensionAt(bar, bars);
      const chordRootDeg = pickChordRoot(tension, rng);
      // triad → 7th → 9th as tension climbs
      const stack = tension > 0.66 ? [0, 2, 4, 6, 8] : tension > 0.4 ? [0, 2, 4, 6] : [0, 2, 4];
      const t = bar * STEPS_PER_BAR * stepSec;
      const dur = STEPS_PER_BAR * stepSec * 0.96;
      for (const offset of stack) {
        const pitch = degreeToMidi(chordRootDeg + offset, scale, root);
        notes.push({
          pitch,
          startTime: t,
          endTime: t + dur,
          velocity: Math.round(46 + tension * 22),
          instrument: "chords",
        });
      }
    }

    // ── drums (four-on-the-floor + Euclidean hats + fills) ───────────
    onStatus("[RHYTHM] Euclidean distribution + tension gating…");
    const hatPulses = Math.round(4 + dna.danceability * 10); // 4–14 of 16
    const hatMask = euclid(hatPulses, STEPS_PER_BAR);
    for (let bar = 0; bar < bars; bar++) {
      const tension = tensionAt(bar, bars);
      const isDrop = tensionAt(bar, bars) > tensionAt((bar + 1) % bars, bars) && tension > 0.55;
      const phrasePos = bar % 8;
      const isFillBar = phrasePos === 7;

      for (let step = 0; step < STEPS_PER_BAR; step++) {
        const t = (bar * STEPS_PER_BAR + step) * stepSec;

        // kick: four-on-the-floor, thinned out during low-energy builds
        if (step % 4 === 0) {
          const present = dna.energy > 0.25 || step === 0;
          if (present && !(isFillBar && step === 12 && rng() < 0.5)) {
            notes.push(drum(36, t, stepSec, 105));
          }
        }
        // snare / clap on 2 and 4
        if (step === 4 || step === 12) {
          notes.push(drum(38, t, stepSec, 92));
        }
        // hats via Euclidean mask, louder when the drop hits
        if (hatMask[step]) {
          const open = step % 4 === 2 && tension > 0.5;
          notes.push(drum(open ? 46 : 42, t, stepSec, 50 + (isDrop ? 18 : 0)));
        }
        // fill: extra snare hits on the last bar of a phrase
        if (isFillBar && step >= 12 && step % 1 === 0 && rng() < 0.6) {
          notes.push(drum(38, t, stepSec * 0.5, 70 + step));
        }
      }
    }

    onStatus(`[DONE] ${notes.length} events across melody · chords · drums`);
    return notes.sort((a, b) => a.startTime - b.startTime);
  }
}

function drum(pitch: number, t: number, stepSec: number, velocity: number): NoteEvent {
  return {
    pitch,
    startTime: t,
    endTime: t + stepSec * 0.5,
    velocity,
    instrument: "drums",
  };
}

/** Derive a visual DNA vector from raw controls (for the radar/character). */
export function featuresFromConfig(config: GeneratorConfig): AudioFeatures {
  return {
    tempo:        config.tempo,
    energy:       config.energy,
    valence:      config.valence,
    danceability: config.density,
    acousticness: clamp(0.4 - config.energy * 0.3),
    brightness:   clamp(config.valence * 0.6 + 0.2),
    source:       "CONTROLS",
  };
}

/** Module-level singleton. */
export const generativeEngine = new GenerativeEngine();
