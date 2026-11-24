/**
 * Writes a track from the controls and a seed.
 *
 * Dark groove is loop music, so the craft is in three places:
 *   groove     a kick on the grid, with every other part sitting just behind it
 *   polymeter  loops of 3, 5, 6, 7 or 12 steps turning against the 16-step bar
 *   evolution  one layer in or out at a time, small changes every 4 and 8 bars
 *
 * The bass holds the tonic and stabs are bare intervals, so nothing turns into a tune.
 * The same seed and controls always give the same track.
 *
 * Groove has a composer of its own, in lib/groove. The other styles are written here.
 */

import type {
  Automation, GeneratorConfig, Lane, MixParams, NoteEdit, NoteEvent,
  RiffInfo, Section, SectionKind, StyleId, Track,
} from "../types";
import { KITS, RUMBLE_ROOT, withSounds, type Kit } from "./audio/kits";
import { djVersion } from "./groove/dj";
import { composeGroove, grooveMoves } from "./groove/compose";
import { neuralRiff } from "./neural-engine";
import {
  clamp, degToMidi, FEEL, fold, fxNote, hitNoise, laneRng, laneSeed, makeRng, note, PERC, SPB, variantOf, vel,
} from "./writing";

/* ───────────────────────── music theory ──────────────────────────── */

const SCALES = {
  phrygian:      [0, 1, 3, 5, 7, 8, 10],
  "natural-minor": [0, 2, 3, 5, 7, 8, 10],
  dorian:        [0, 2, 3, 5, 7, 9, 10],
  major:         [0, 2, 4, 5, 7, 9, 11],
} as const;

function chooseScale(cfg: GeneratorConfig): { scale: readonly number[]; tonality: "minor" | "major" } {
  if (cfg.mode === "major") return { scale: SCALES.major, tonality: "major" };
  if (cfg.mode === "minor") return { scale: SCALES["natural-minor"], tonality: "minor" };
  if (cfg.valence < 0.3) return { scale: SCALES.phrygian, tonality: "minor" };
  if (cfg.valence < 0.62) return { scale: SCALES["natural-minor"], tonality: "minor" };
  return { scale: SCALES.dorian, tonality: "minor" };
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

const pick = <T,>(items: readonly T[], rng: () => number): T => items[Math.floor(rng() * items.length) % items.length];

/** Euclidean rhythm (even spread): `hits` placed as evenly as possible over `steps`. */
export function euclid(hits: number, steps: number, rotate = 0): boolean[] {
  const out: boolean[] = new Array(steps).fill(false);
  for (let i = 0; i < hits; i++) out[(Math.floor((i * steps) / hits) + rotate) % steps] = true;
  return out;
}

/** A rewrite steps on from the seed's choice, so it can never land on the same one. */
function choice<T>(items: readonly T[], cfg: GeneratorConfig, lane: Lane): T {
  return items[variantOf(cfg, lane, items.length)];
}

/* ──────────────────────── style definitions ──────────────────────── */

interface Style {
  bass:      "rolling" | "offbeat" | "acid" | "dub" | "sub" | "tresillo";
  clap:      "clap" | "rim" | "sparse";
  openHats:  number[];   // steps with an open hat
  hatAccent: number[];   // velocity of the four 16ths in a beat
  toms:      number;     // 0–1, how much of the rolling tuned-tom line plays
  loops:     number[];   // lengths the percussion loops may take, in steps
  stabs:     { hits: number[]; len: number }[]; // a rhythm and the loop it turns over
  stabLen:   number;     // in steps
  voicing:   number[];   // scale degrees in the stab
  leadKeep:  number;     // share of the riff's notes the sequence plays
  leadLen:   number;     // in steps
  pump:      number;
  space:     number;
  echo:      number;
  rumble:    number;
}

const STYLES: Record<StyleId, Style> = {
  driving: {
    bass: "rolling", clap: "clap", openHats: [2, 6, 10, 14], hatAccent: [0.62, 0.4, 1, 0.55],
    toms: 0.45, loops: [6, 7, 12], stabs: [{ hits: [3], len: 16 }, { hits: [6], len: 32 }, { hits: [11], len: 16 }], stabLen: 1.5, voicing: [0, 4],
    leadKeep: 0.28, leadLen: 0.8, pump: 0.72, space: 0.3, echo: 0.36, rumble: 0.65,
  },
  hypnotic: {
    bass: "offbeat", clap: "rim", openHats: [2, 10], hatAccent: [0.5, 0.35, 0.9, 0.6],
    toms: 0.35, loops: [5, 6, 7], stabs: [{ hits: [3], len: 12 }, { hits: [10], len: 32 }, { hits: [6], len: 16 }], stabLen: 2, voicing: [0, 4],
    leadKeep: 0.4, leadLen: 0.65, pump: 0.6, space: 0.45, echo: 0.6, rumble: 0.6,
  },
  tribal: {
    bass: "tresillo", clap: "sparse", openHats: [6, 14], hatAccent: [0.7, 0.45, 0.85, 0.65],
    toms: 1, loops: [3, 5, 12], stabs: [{ hits: [14], len: 32 }, { hits: [6], len: 32 }], stabLen: 1.2, voicing: [0, 4],
    leadKeep: 0.2, leadLen: 0.6, pump: 0.6, space: 0.36, echo: 0.3, rumble: 0.5,
  },
  acid: {
    bass: "acid", clap: "clap", openHats: [2, 6, 10, 14], hatAccent: [0.55, 0.3, 1, 0.45],
    toms: 0.25, loops: [6, 8, 12], stabs: [], stabLen: 2, voicing: [0],
    leadKeep: 0.16, leadLen: 0.6, pump: 0.66, space: 0.3, echo: 0.42, rumble: 0.5,
  },
  dub: {
    bass: "dub", clap: "rim", openHats: [14], hatAccent: [0.4, 0.3, 0.85, 0.5],
    toms: 0.15, loops: [5, 7, 12], stabs: [{ hits: [3], len: 16 }, { hits: [6], len: 16 }, { hits: [3, 10], len: 32 }], stabLen: 3, voicing: [0, 2, 4],
    leadKeep: 0.15, leadLen: 1.2, pump: 0.5, space: 0.62, echo: 0.9, rumble: 0.5,
  },
  warehouse: {
    bass: "sub", clap: "sparse", openHats: [2, 10], hatAccent: [0.7, 0.5, 1, 0.5],
    toms: 0.6, loops: [3, 7, 12], stabs: [{ hits: [6], len: 32 }, { hits: [10], len: 24 }], stabLen: 1.5, voicing: [0, 7],
    leadKeep: 0.22, leadLen: 0.6, pump: 0.85, space: 0.42, echo: 0.28, rumble: 0.9,
  },
  hard: {
    bass: "sub", clap: "clap", openHats: [2, 6, 10, 14], hatAccent: [0.8, 0.55, 1, 0.65],
    toms: 0.3, loops: [3, 4, 6], stabs: [{ hits: [6], len: 32 }], stabLen: 1, voicing: [0, 7],
    leadKeep: 0.12, leadLen: 0.5, pump: 0.9, space: 0.3, echo: 0.2, rumble: 1,
  },
};

/* ────────────────────────── arrangement ──────────────────────────── */

export const LENGTHS = [16, 32, 64, 96, 128, 176, 208];

const LAYOUTS: Record<number, [SectionKind, number][]> = {
  16: [["intro", 2], ["groove", 4], ["break", 2], ["build", 2], ["drop", 6]],
  32: [["intro", 4], ["groove", 8], ["break", 4], ["build", 4], ["drop", 8], ["outro", 4]],
  64: [["intro", 4], ["groove", 12], ["riff", 16], ["break", 4], ["build", 4], ["drop", 16], ["outro", 8]],
  96: [["intro", 8], ["groove", 16], ["riff", 24], ["break", 8], ["build", 8], ["drop", 24], ["outro", 8]],
  128: [["intro", 8], ["groove", 16], ["riff", 32], ["break", 8], ["build", 8], ["drop", 40], ["outro", 16]],
  // five minutes at 138 BPM, the middle of the reference playlist
  176: [["intro", 16], ["groove", 16], ["riff", 32], ["break", 8], ["build", 8], ["drop", 32], ["riff", 16], ["break", 4], ["build", 4], ["drop", 24], ["outro", 16]],
  // a full club length, like Takt "Groove Chaser" (211 bars at 145)
  208: [["intro", 16], ["groove", 16], ["riff", 40], ["break", 8], ["build", 8], ["drop", 40], ["riff", 24], ["break", 4], ["build", 4], ["drop", 32], ["outro", 16]],
};

function nearestLength(bars: number): number {
  return LENGTHS.reduce((a, b) => (Math.abs(b - bars) < Math.abs(a - bars) ? b : a));
}

// Hard takes its time in the middle: TRAIN FANTOME's breakdown runs 36 of its 157 bars
const HARD_LAYOUTS: Record<number, [SectionKind, number][]> = {
  96: [["intro", 8], ["groove", 8], ["riff", 8], ["break", 16], ["build", 8], ["drop", 40], ["outro", 8]],
  128: [["intro", 8], ["groove", 16], ["riff", 12], ["break", 20], ["build", 8], ["drop", 52], ["outro", 12]],
  176: [["intro", 8], ["groove", 16], ["riff", 20], ["break", 28], ["build", 8], ["drop", 80], ["outro", 16]],
  208: [["intro", 16], ["groove", 16], ["riff", 24], ["break", 28], ["build", 8], ["drop", 96], ["outro", 20]],
};

export function arrange(bars: number, style?: StyleId): Section[] {
  let at = 0;
  const length = nearestLength(bars);
  const layout = (style === "hard" && HARD_LAYOUTS[length]) || LAYOUTS[length];
  return layout.map(([kind, length]) => {
    const s = { kind, startBar: at, bars: length };
    at += length;
    return s;
  });
}

/** How far through a section each layer arrives. Absent means it doesn't play. */
type Element = "kick" | "clap" | "hats" | "open" | "ride" | "shaker" | "perc" | "toms" | "bass" | "stab" | "lead" | "pad";
const ENTRIES: Record<SectionKind, Partial<Record<Element, number>>> = {
  intro:  { kick: 0, hats: 0, perc: 0, toms: 0.5, shaker: 0.5, pad: 0 },
  groove: { kick: 0, hats: 0, perc: 0, shaker: 0, bass: 0, open: 0.25, clap: 0.25, toms: 0.5, stab: 0.5, lead: 0.75 },
  riff:   { kick: 0, hats: 0, perc: 0, shaker: 0, bass: 0, open: 0, clap: 0, toms: 0, lead: 0, stab: 0.25, pad: 0.5, ride: 0.75 },
  break:  { perc: 0, toms: 0, stab: 0, lead: 0, pad: 0, hats: 0.5 },
  build:  { kick: 0.5, perc: 0, toms: 0, shaker: 0, hats: 0, stab: 0, lead: 0, pad: 0 },
  drop:   { kick: 0, hats: 0, open: 0, perc: 0, toms: 0, shaker: 0, bass: 0, clap: 0, ride: 0, stab: 0, lead: 0, pad: 0.5 },
  outro:  { kick: 0, hats: 0, perc: 0, toms: 0, bass: 0, clap: 0 },
};

/** The outro hands over to the next record by shedding a layer at a time. */
const EXITS: Partial<Record<Element, number>> = { clap: 0.25, toms: 0.5, bass: 0.5, perc: 0.75 };

/** Layers that may briefly step out at the end of a phrase. */
const DROPOUTS: Element[] = ["hats", "perc", "shaker", "toms", "bass", "stab", "open"];

/* ─────────────────────────── engine ──────────────────────────────── */

const RIFF_STEPS = 32;  // two bars

export class GenerativeEngine {
  generate(cfg: GeneratorConfig, edits: NoteEdit[] = []): Track {
    if (cfg.style === "driving") return this.groove(cfg, edits);
    const style = STYLES[cfg.style];
    const { scale, tonality } = chooseScale(cfg);
    const root = cfg.rootPitch;
    const stepSec = 60 / cfg.tempo / 4;
    const time = (step: number) => step * stepSec;

    const sections = arrange(cfg.bars, cfg.style);
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

    const kit = withSounds(KITS[cfg.style], cfg.sounds);
    const mix = mixFor(cfg, style, kit);
    const inTrack = edits.filter((e) => e.step < bars * SPB);
    const final = applyEdits(notes, inTrack, time, stepSec, root).sort((a, b) => a.startTime - b.startTime);
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
      kit,
      riff: riff.info,
    };
  }

  private groove(cfg: GeneratorConfig, edits: NoteEdit[]): Track {
    // the DJ version wraps the longest arrangement
    const body = cfg.dj ? LENGTHS[LENGTHS.length - 1] : nearestLength(cfg.bars);
    const { scale, tonality } = chooseScale(cfg);
    const stepSec = 60 / cfg.tempo / 4;
    const composed = composeGroove(cfg, body);
    const { pulls, family } = composed;
    // a swap holds for the whole track, across the family's change of sounds at the drop
    const kit = withSounds(composed.kit, cfg.sounds);
    const mix = mixFor(cfg, family.mix, kit);
    let parts = {
      notes: composed.notes,
      sections: composed.sections,
      automation: grooveMoves(composed.sections, pulls, stepSec, mix),
      endKit: { ...composed.endKit, kit: withSounds(composed.endKit.kit, cfg.sounds) },
      stepSec,
    };
    let bars = body;
    let time = composed.time;
    if (cfg.dj) {
      const dj = djVersion(parts);
      parts = dj;
      bars = dj.totalBars;
      // a step in the drums at either end sits where the same step of a bar would
      time = (step: number) => step < dj.offsetSteps ? composed.time(step) : composed.time(step - dj.offsetSteps) + dj.offsetSteps * stepSec;
    }
    const { notes, sections, automation, endKit } = parts;
    // edits are in the finished track's steps, so they go on last
    const inTrack = edits.filter((e) => e.step < bars * SPB);
    return {
      config: cfg,
      notes: applyEdits(notes, inTrack, time, stepSec, cfg.rootPitch).sort((a, b) => a.startTime - b.startTime),
      sections,
      automation,
      bpm: cfg.tempo,
      stepSec,
      durationSec: bars * SPB * stepSec,
      root: cfg.rootPitch,
      tonality,
      scale,
      mix,
      kit,
      endKit,
      family: { id: family.id, name: family.name, about: family.about },
      riff: { neural: false, tokens: [], vocab: [], probs: [], temperature: 0 }, // Groove doesn't use the model
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

/** Whether a layer is playing in this bar. This is where the arrangement evolves. */
function plays(c: WriteContext, el: Element, bar: number): boolean {
  const sec = sectionAt(c.sections, bar);
  const enters = ENTRIES[sec.kind][el];
  if (enters == null) return false;
  const progress = (bar - sec.startBar) / sec.bars;
  if (progress < enters) return false;
  if (sec.kind === "outro" && progress >= (EXITS[el] ?? 1)) return false;
  if ((sec.kind === "groove" || sec.kind === "riff" || sec.kind === "drop") && bar % 8 >= 6) {
    const phrase = Math.floor(bar / 8);
    const out = DROPOUTS[Math.floor(hitNoise(c.cfg.seed, phrase, 91) * DROPOUTS.length)];
    if (el === out && hitNoise(c.cfg.seed, phrase, 92) < 0.35 + c.cfg.variation * 0.5) return false;
  }
  return true;
}

/** The style's stab as semitones above the tonic. Only Dub has a third. */
function chordShape(c: WriteContext): number[] {
  return c.style.voicing.map((d) => degToMidi(d, c.scale, 0));
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
  const hatGate = Array.from({ length: SPB }, () => hatRng());
  const ghostKick = pick([7, 11, 15, 3], roll);
  const ghostClap = pick([7, 9, 15], roll);
  const sparseClap = pick([4, 12], roll);

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    const last = bar === sec.startBar + sec.bars - 1;
    const on = (el: Element) => plays(c, el, bar);
    const kick = on("kick"), clap = on("clap"), hats = on("hats"), open = on("open"), ride = on("ride");
    const lift = bar % 16 === 15 && (sec.kind === "groove" || sec.kind === "riff");
    const fill = bar % 8 === 7 && hitNoise(cfg.seed, bar, 11) < 0.4 + cfg.variation;

    for (let s = 0; s < SPB; s++) {
      const step = bar * SPB + s;
      // the beat before the drop pulls the floor away
      if (sec.kind === "build" && last && s >= 12) continue;

      if (kick && s % 4 === 0 && !(lift && s === 12)) note(c, "drums", step, 36, 2, vel(c, 122), FEEL.kick);
      if (kick && s === ghostKick && bar % 2 === 1 && cfg.energy > 0.4) note(c, "drums", step, 35, 1, vel(c, 78), FEEL.ghost);

      if (clap) {
        const main = style.clap === "sparse" ? s === sparseClap && bar % 2 === 1 : s === 4 || s === 12;
        const pitch = style.clap === "rim" && sec.kind !== "drop" ? 37 : 39;
        if (main) note(c, "drums", step, pitch, 1, vel(c, 98), FEEL.clap);
        else if (s === ghostClap && bar % 4 === 3) note(c, "drums", step, pitch, 1, vel(c, 54), FEEL.clap);
        else if (fill && (s === 14 || s === 15) && style.clap !== "clap") note(c, "drums", step, 37, 1, vel(c, 60 + (s - 14) * 16), FEEL.clap);
      }

      if (open && style.openHats.includes(s)) {
        note(c, "drums", step, 46, 2, vel(c, s === 2 || s === 10 ? 92 : 78), FEEL.open);
      } else if (hats) {
        const accent = style.hatAccent[s % 4];
        // the offbeat is always there, and density fills in around it
        const keep = s % 4 === 2 || hatGate[s] < 0.12 + cfg.density * 0.95;
        const thin = sec.kind === "intro" && bar - sec.startBar < sec.bars / 2 && s % 2 === 1;
        if (keep && !thin) note(c, "drums", step, 42, 1, vel(c, 34 + accent * 70), FEEL.hat);
      }

      if (ride && cfg.energy > 0.45 && s % 2 === 0) note(c, "drums", step, 51, 2, vel(c, s % 4 === 2 ? 82 : 52), FEEL.ride);
    }
    if (sec.kind === "drop" && bar === sec.startBar) note(c, "drums", bar * SPB, 49, 16, vel(c, 92));
  }
}

function writePerc(c: WriteContext): void {
  const { cfg, style } = c;
  const rng = laneRng(cfg, "perc");
  const lenA = pick(style.loops, rng);
  const lenB = pick(style.loops.filter((n) => n !== lenA), rng);
  const a = euclid(Math.max(1, Math.round(lenA * (0.25 + rng() * 0.15))), lenA, Math.floor(rng() * lenA));
  const b = euclid(Math.max(1, Math.round(lenB * (0.18 + rng() * 0.15))), lenB, 1 + Math.floor(rng() * (lenB - 1)));
  const tomLine = Array.from({ length: RIFF_STEPS }, () => ({ chance: rng(), voice: Math.floor(rng() ** 1.6 * 3) }));

  for (let bar = 0; bar < c.bars; bar++) {
    const on = (el: Element) => plays(c, el, bar);
    const perc = on("perc"), toms = on("toms"), shaker = on("shaker");
    const turnaround = bar % 4 === 3;
    for (let s = 0; s < SPB; s++) {
      const step = bar * SPB + s;
      // a held-back chance per hit, mostly spent on the last bar of each four
      const n = hitNoise(laneSeed(cfg, "perc"), step, 5);
      const change = (turnaround ? 0.18 : 0.03) * (0.4 + cfg.variation * 1.6);

      if (perc) {
        if (a[step % lenA] && n > change) note(c, "perc", step, PERC.hitA, 1, vel(c, step % lenA === 0 ? 100 : 76), FEEL.perc);
        if (b[step % lenB] && s !== 0 && n < 0.3 + cfg.density * 0.8) note(c, "perc", step, PERC.hitB, 1, vel(c, 72), FEEL.perc);
      }
      if (toms) {
        // rolling toms fill the spaces between kicks
        const cell = tomLine[((bar % 2) * SPB + s) % RIFF_STEPS];
        const chance = style.toms * (0.25 + cfg.density * 0.65) * (s % 4 === 0 ? 0 : s % 4 === 2 ? 0.7 : 1);
        if (cell.chance < chance !== (turnaround && s >= 8 && n < change)) {
          note(c, "perc", step, PERC.toms[cell.voice], 1, vel(c, s % 4 === 3 ? 92 : 64), FEEL.tom);
        }
      }
      if (shaker && cfg.energy > 0.25) {
        const accent = [0.4, 0.55, 1, 0.7][s % 4];
        if (s % 2 === 0 || cfg.density > 0.35) note(c, "perc", step, PERC.shaker, 1, vel(c, 30 + accent * 62), FEEL.shaker);
      }
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
  // outside the 303, the groove is in the gaps and the weight, never in a melody
  const degree = 0;

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
    const inBeat = s % 4;
    if (inBeat === 0) continue; // the kick owns the first 16th of every beat
    if (style.bass === "rolling") {
      if (inBeat === 2 || u[s] < 0.45 + cfg.density * 0.6) pat[s] = { degree: inBeat === 2 ? 0 : degree, length: 0.85, accent: inBeat === 2 || v[s] < 0.15 };
    } else if (style.bass === "offbeat") {
      if (inBeat === 2) pat[s] = { degree: 0, length: 1.3, accent: true };
      else if (inBeat === 3 && u[s] < cfg.density * 0.55) pat[s] = { degree, length: 0.8 };
    } else if (style.bass === "tresillo") {
      const inBar = s % SPB;
      if (inBar === 3 || inBar === 6 || inBar === 11 || inBar === 14) pat[s] = { degree: 0, length: 1.1, accent: inBar === 6 };
      else if (u[s] < cfg.density * 0.22) pat[s] = { degree, length: 0.7 };
    } else if (style.bass === "dub") {
      if (s === 3 || s === 10 || s === 19) pat[s] = { degree: 0, length: s === 10 ? 2 : 3.5 };
      else if (s === 27 && u[s] < 0.6) pat[s] = { degree, length: 2 };
    } else if (inBeat === 2 || (inBeat === 3 && u[s] < cfg.density * 0.35)) {
      pat[s] = { degree: 0, length: 0.95, accent: s % SPB === 6 };
    }
  }
  return pat;
}

// E1 to D#2: the octave a club system reproduces, and the kick doesn't bury
const BASS_RANGE: [number, number] = [28, 39];
const ACID_RANGE: [number, number] = [31, 50];

function writeBass(c: WriteContext): void {
  const pat = bassPattern(c);
  const acid = c.style.bass === "acid";
  const [lo, hi] = acid ? ACID_RANGE : BASS_RANGE;
  const base = 24 + c.root; // a multiple of 12, so `root` stays the pitch class
  const seed = laneSeed(c.cfg, "bass");
  for (let bar = 0; bar < c.bars; bar++) {
    if (!plays(c, "bass", bar)) continue;
    for (let s = 0; s < SPB; s++) {
      const cell = pat[(bar % 2) * SPB + s];
      if (!cell) continue;
      const step = bar * SPB + s;
      // the turnaround loses a note, rather than gaining a fill
      if (bar % 8 === 7 && s >= 10 && hitNoise(seed, step, 3) < c.cfg.variation) continue;
      const pitch = fold(degToMidi(cell.degree, c.scale, base), lo, hi);
      const velocity = cell.accent ? 120 : 100 - (s % 4 === 1 ? 18 : 0);
      note(c, "bass", step, pitch, cell.length, vel(c, velocity), FEEL.bass, { accent: cell.accent, slide: cell.slide });
    }
  }
}

/* ─────────────────────────── harmony ─────────────────────────────── */

function writeChords(c: WriteContext): void {
  const { cfg, style } = c;
  const shape = chordShape(c);
  const pitch = fold(48 + c.root, 48, 59);
  // every loop, moved by every whole beat that gives a different rhythm, so a stab never lands on a kick
  const options = style.stabs.flatMap((l) => {
    const seen = new Set<string>();
    return [0, 4, 8, 12].flatMap((shift) => {
      const hits = l.hits.map((h) => (h + shift) % l.len).sort((a, b) => a - b);
      if (seen.has(hits.join())) return [];
      seen.add(hits.join());
      return [{ hits, len: l.len }];
    });
  });
  const loop = options.length ? choice(options, cfg, "stab") : null;
  const seed = laneSeed(cfg, "stab");
  const texture = variantOf(cfg, "pad", 5);

  for (let bar = 0; bar < c.bars; bar++) {
    const sec = sectionAt(c.sections, bar);
    if (loop && plays(c, "stab", bar)) {
      for (let s = 0; s < SPB; s++) {
        const step = bar * SPB + s;
        if (!loop.hits.includes(step % loop.len)) continue;
        if (bar % 8 === 7 && hitNoise(seed, step, 2) < cfg.variation * 0.7) continue;
        note(c, "stab", step, pitch, style.stabLen, vel(c, sec.kind === "break" ? 78 : 90), FEEL.synth, { chord: shape });
      }
    }
    if ((bar - sec.startBar) % 2 === 0 && plays(c, "pad", bar)) {
      const span = Math.min(2, sec.startBar + sec.bars - bar) * SPB;
      note(c, "pad", bar * SPB, pitch, span, vel(c, sec.kind === "break" ? 92 : 66), {}, { variant: texture });
    }
  }
}

/* ────────────────────────── sequence ─────────────────────────────── */

function writeLead(c: WriteContext): void {
  const { cfg, style, scale } = c;
  const rng = laneRng(cfg, "lead");
  for (let i = 0; i < RIFF_STEPS; i++) rng(); // stay clear of the draws the riff used
  const keep = Array.from({ length: RIFF_STEPS }, () => rng());
  const played = c.riff.map((d, i) => d != null && keep[i] < style.leadKeep);
  // a style that plays few notes still gets one to hang the echo on
  const first = c.riff.findIndex((d) => d != null);
  if (first >= 0 && !played.some(Boolean)) played[first] = true;
  const seed = laneSeed(cfg, "lead");
  const base = 60 + c.root;

  for (let bar = 0; bar < c.bars; bar++) {
    if (!plays(c, "lead", bar)) continue;
    for (let s = 0; s < SPB; s++) {
      const i = (bar % 2) * SPB + s;
      const d = c.riff[i];
      if (d == null || !played[i]) continue;
      const step = bar * SPB + s;
      const answer = bar % 8 >= 6 && hitNoise(seed, step, 4) < cfg.variation * 0.35;
      const pitch = fold(degToMidi(answer ? d + 2 : d, scale, base), 52, 71);
      note(c, "lead", step, pitch, style.leadLen, vel(c, s % 4 === 3 ? 96 : 78), FEEL.synth);
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

function mixFor(cfg: GeneratorConfig, style: Pick<Style, "pump" | "space" | "echo" | "rumble">, kit: Kit): MixParams {
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
    grit: kit.grit ?? 0,
  };
}

function automationFor(sections: Section[], stepSec: number, mix: MixParams): Automation[] {
  const bar = stepSec * SPB;
  const space = 0.2 + mix.space * 0.65;
  const echo = 0.25 + mix.echo * 0.34;
  const out: Automation[] = [
    { time: 0, param: "cutoff", from: 2400, value: 2400, ramp: 0 },
    { time: 0, param: "space", from: space, value: space, ramp: 0 },
    { time: 0, param: "echo", from: echo, value: echo, ramp: 0 },
  ];
  // each move starts where the last one left that control
  const at: Record<Automation["param"], number> = { cutoff: 2400, space, echo, acid: 0.2, low: 1 };
  const move = (time: number, param: Automation["param"], value: number, ramp: number) => {
    out.push({ time, param, from: at[param], value, ramp });
    at[param] = value;
  };
  const acidOpen: Record<SectionKind, number> = { intro: 0.2, groove: 0.45, riff: 0.7, break: 0.35, build: 1, drop: 1, outro: 0.5 };
  for (const s of sections) {
    const t = s.startBar * bar;
    const len = s.bars * bar;
    for (let b = 0; b < s.bars; b++) {
      // a slow hand on the 303's cutoff
      const wave = Math.sin(((s.startBar + b) / 16) * Math.PI * 2);
      move(t + b * bar, "acid", clamp(acidOpen[s.kind] * (0.8 + wave * 0.2)), 0);
    }
    if (s.kind === "break") {
      move(t, "cutoff", 1100, bar);
      move(t, "space", Math.min(0.95, space + 0.25), len);
      move(t, "echo", Math.min(0.62, echo + 0.16), len);
    } else if (s.kind === "build") {
      move(t, "cutoff", 15000, len);
    } else if (s.kind === "drop") {
      move(t, "space", space, 0.05);
      move(t, "echo", echo, 0.05);
      // open, then breathe every eight bars
      for (let b = 0; b < s.bars; b += 8) move(t + b * bar, "cutoff", b % 16 === 0 ? 16000 : 6500, Math.min(8, s.bars - b) * bar);
    } else if (s.kind === "outro") {
      move(t, "cutoff", 1600, len);
    } else {
      move(t, "cutoff", s.kind === "intro" ? 3800 : s.kind === "groove" ? 6500 : 11000, len);
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ─────────────────────────── edits ───────────────────────────────── */

const PITCHED: Lane[] = ["bass", "stab", "lead", "pad"];

/** Where an edit's note sits in the current key. */
export function editPitch(e: NoteEdit, root: number): number {
  if (e.root == null || !PITCHED.includes(e.lane)) return e.pitch;
  const moved = e.pitch + ((root - e.root + 18) % 12) - 6;
  return clamp(moved, 0, 127);
}

/**
 * Replay piano-roll edits over freshly written notes. A pitched lane plays one
 * note at a time, so a deletion means "nothing written here", whatever pitch a
 * new key or scale gives that note. Added notes are never hit by a deletion.
 */
export function applyEdits(notes: NoteEvent[], edits: NoteEdit[], time: (step: number) => number, stepSec: number, root: number): NoteEvent[] {
  const removed = new Set(edits.filter((e) => e.op === "remove").map((e) => `${e.lane}:${e.step}:${PITCHED.includes(e.lane) ? "" : e.pitch}`));
  const out = notes.filter((n) => {
    const pitched = PITCHED.includes(n.instrument as Lane);
    return !removed.has(`${n.instrument}:${n.step}:${pitched ? "" : n.pitch}`);
  });
  for (const e of edits) {
    if (e.op !== "add") continue;
    const start = time(e.step);
    const length = e.lane === "drums" || e.lane === "perc" ? 1 : 1.6;
    out.push({ pitch: editPitch(e, root), step: e.step, startTime: start, endTime: start + length * stepSec, velocity: 100, instrument: e.lane });
  }
  return out;
}

/* ───────────────────────── seeds ───────────────────────────── */

export function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/** The first track anyone hears, and what a partial link falls back to. */
export const DEFAULT_CONFIG: GeneratorConfig = {
  style: "driving", bars: 64, tempo: 138, energy: 0.72, valence: 0.25, density: 0.65,
  variation: 0.35, rootPitch: 9, mode: "auto", seed: 909, laneSeeds: {}, pins: {},
};

export const generativeEngine = new GenerativeEngine();
