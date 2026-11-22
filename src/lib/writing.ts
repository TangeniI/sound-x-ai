/**
 * lib/writing.ts
 *
 * What both composers write with: seeded randomness, how far each voice sits
 * behind the grid, and the helpers that turn a step into a note.
 */

import type { GeneratorConfig, Lane, NoteEvent } from "../types";

export const SPB = 16;         // steps per bar

/** The part of a composer's context a note needs. */
export interface Score {
  cfg:     GeneratorConfig;
  notes:   NoteEvent[];
  time:    (step: number) => number;
  stepSec: number;
}

export function degToMidi(degree: number, scale: readonly number[], root: number): number {
  const len = scale.length;
  const oct = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return root + oct * 12 + scale[idx];
}

/** Fold a pitch into a register by octaves. */
export function fold(pitch: number, lo: number, hi: number): number {
  let p = pitch;
  while (p > hi) p -= 12;
  while (p < lo) p += 12;
  return p;
}

export function makeRng(seed: number): () => number {
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
export function laneRng(cfg: GeneratorConfig, lane: Lane | "hats"): () => number {
  return makeRng(laneSeed(cfg, lane));
}

export function laneSeed(cfg: GeneratorConfig, lane: Lane | "hats"): number {
  let h = (cfg.seed ^ 0x811c9dc5) >>> 0;
  const salt = `${lane}:${lane === "hats" ? cfg.laneSeeds.drums ?? 0 : cfg.laneSeeds[lane] ?? 0}`;
  for (let i = 0; i < salt.length; i++) h = Math.imul(h ^ salt.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A fixed random value for one hit, so variation is identical live and in an export. */
export function hitNoise(seed: number, step: number, salt = 0): number {
  let h = Math.imul(seed ^ (step + 1), 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

export const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export function variantOf(cfg: GeneratorConfig, lane: Lane, count: number): number {
  const first = Math.floor(makeRng(laneSeed({ ...cfg, laneSeeds: {} }, lane))() * count);
  return (first + (cfg.laneSeeds[lane] ?? 0)) % count;
}

export interface Feel {
  late?:  number; // seconds behind the grid, the same on every hit of this voice
  loose?: number; // seconds of hit-to-hit drift on top
  touch?: number; // share of velocity that varies from hit to hit
}

// The kick is the grid. Everything else leans back from it by its own amount.
export const FEEL = {
  kick:   { touch: 0.02 },
  ghost:  { late: 0.004, loose: 0.002 },
  clap:   { late: 0.007, loose: 0.003 },
  hat:    { late: 0.002, loose: 0.003, touch: 0.22 },
  open:   { late: 0.005, loose: 0.002 },
  ride:   { late: 0.003, loose: 0.002 },
  shaker: { late: 0.009, loose: 0.005, touch: 0.3 },
  perc:   { late: 0.004, loose: 0.004, touch: 0.25 },
  tom:    { late: 0.006, loose: 0.003, touch: 0.25 },
  bass:   { late: 0.002, loose: 0.001, touch: 0.08 },
  synth:  { late: 0.003, loose: 0.002, touch: 0.14 },
} satisfies Record<string, Feel>;

export function note(c: Score, instrument: Lane, step: number, pitch: number, length: number, velocity: number, feel: Feel = {}, extra: Partial<NoteEvent> = {}): void {
  const seed = laneSeed(c.cfg, instrument);
  const start = c.time(step) + (feel.late ?? 0) + hitNoise(seed, step, pitch) * (feel.loose ?? 0);
  const touch = 1 + (hitNoise(seed, step, pitch + 128) - 0.5) * (feel.touch ?? 0.1);
  c.notes.push({ pitch, step, startTime: start, endTime: start + length * c.stepSec, velocity: Math.round(clamp(velocity * touch, 1, 127)), instrument, ...extra });
}

/** Energy lifts every hit a little, so the whole mix leans in or backs off. */
export const vel = (c: Score, base: number) => base * (0.7 + c.cfg.energy * 0.42);

export function fxNote(c: Score, pitch: number, step: number, length: number): NoteEvent {
  const start = step * c.stepSec;
  return { pitch, step, startTime: start, endTime: start + length * c.stepSec, velocity: 100, instrument: "fx" };
}

/** Percussion pitches, one per voice. The three toms are tuned to the key. */
export const PERC = { hitA: 56, hitB: 60, shaker: 64, toms: [45, 47, 50] } as const;

