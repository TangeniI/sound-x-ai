/**
 * lib/groove/compose.ts
 *
 * Writes a Groove track: one idea that develops from the beginning through the
 * middle to the end, layers that come and go around it, and a floor that leaves
 * before each hit and lands on the one.
 */

import type { Automation, GeneratorConfig, MixParams, NoteEvent, Section } from "../../types";
import type { Kit } from "../audio/kits";
import {
  clamp, FEEL, fold, fxNote, hitNoise, laneSeed, note, PERC, SPB, vel, type Score,
} from "../writing";
import { grooveSections, loopBars, placeOf, pullsFor, type Place, type Pull } from "./flow";
import { chooseParts, familyOf, hitAt, type Parts } from "./parts";

const LEVEL: Record<string, number> = { x: 1, o: 0.8, "-": 0.58, h: 0.94, t: 0.92, u: 0.96 };

interface Ctx extends Score {
  parts:    Parts;
  bars:     number;
  sections: Section[];
  pulls:    Pull[];
}

/** What is true of one 16th, which every writer needs to know. */
interface Moment {
  step: number;
  bar:  number;
  s:    number; // the 16th within the bar
  sec:  Section;
  place: Place;
  /** A phrase that steps back to the bare idea, so the return means something. */
  bare: boolean;
  pull?: Pull;
  low:  "full" | "thin" | "gone";
  toHit: number; // steps until the pull lands, Infinity outside one
}

export interface GrooveTrack {
  notes:    NoteEvent[];
  sections: Section[];
  pulls:    Pull[];
  time:     (step: number) => number;
  family:   Parts["family"];
  kit:      Kit;
  endKit:   { from: number; kit: Kit };
}

export function composeGroove(cfg: GeneratorConfig, bars: number): GrooveTrack {
  const parts = chooseParts(cfg);
  const { family } = parts;
  const stepSec = 60 / cfg.tempo / 4;
  // dead straight: the references measured within 2 ms of the grid, no swing
  const time = (step: number) => step * stepSec;
  const sections = grooveSections(cfg, bars);
  const c: Ctx = { cfg, parts, bars, sections, time, stepSec, notes: [], pulls: pullsFor(cfg, family, sections, bars) };

  for (let bar = 0; bar < bars; bar++) {
    const sec = sections.find((x) => bar >= x.startBar && bar < x.startBar + x.bars)!;
    const place = placeOf(sections, bar);
    const bare = (place.act === "middle" && place.phrase % 4 === 3) || (place.act === "end" && place.phrase % 4 === 2);
    for (let s = 0; s < SPB; s++) {
      const step = bar * SPB + s;
      const pull = c.pulls.find((p) => step >= p.from && step < p.to);
      const low = !pull ? "full" : step >= pull.gone ? "gone" : "thin";
      const m: Moment = { step, bar, s, sec, place, bare, pull, low, toHit: pull ? pull.to - step : Infinity };
      writeKick(c, m);
      writeClap(c, m);
      writeTops(c, m);
      writeIdea(c, m);
      writeSupport(c, m);
    }
  }
  writeEvents(c);
  const endKit = { from: loopBars(sections).start * SPB, kit: kitFor(cfg, 1) };
  return { notes: c.notes, sections, pulls: c.pulls, time, family, kit: kitFor(cfg), endKit };
}

/**
 * A family's sounds. The seed picks the set a take opens with, and the end
 * plays another, so the drop changes the sound as well as the notes.
 */
export function kitFor(cfg: GeneratorConfig, turn = 0): Kit {
  const family = familyOf(cfg);
  const first = Math.floor(hitNoise(cfg.seed, 1, 42) * family.alts.length);
  return { ...family.kit, ...family.alts[(first + turn) % family.alts.length] };
}

const through = (m: Moment) => (m.bar - m.sec.startBar + m.s / SPB) / m.sec.bars;
const inBreak = (m: Moment) => m.sec.kind === "break" || m.sec.kind === "build";

/** Layers arrive on blocks of the track, and the short lengths skip the wait. */
function arrived(c: Ctx, m: Moment, at: number): boolean {
  if (m.sec.kind === "drop") return true;
  const scale = c.bars >= 96 ? 1 : c.bars >= 64 ? 0.75 : c.bars >= 32 ? 0.5 : 0;
  return m.bar >= Math.floor((at * scale) / 4) * 4;
}

/** The last two 16ths of a wind-down, for families that leave them empty. */
function inGap(c: Ctx, m: Moment): boolean {
  return c.parts.family.tension === "gap" && m.toHit <= (m.pull?.main ? 4 : 2);
}

/* ──────────────────────────── the floor ─────────────────────────────── */

function writeKick(c: Ctx, m: Moment): void {
  const { family } = c.parts;
  if (inBreak(m)) return;
  if (m.low === "gone") return;
  if (m.s % 4 === 0) {
    if (m.low === "thin") note(c, "drums", m.step, 35, 1, vel(c, 116), FEEL.kick);
    else note(c, "drums", m.step, 36, 2, vel(c, 122), FEEL.kick);
  } else if (m.low === "full" && m.s === family.pickup && m.bar % 2 === 1 && c.cfg.energy > 0.4) {
    note(c, "drums", m.step, 35, 1, vel(c, 74), FEEL.ghost);
  }
}

/* ─────────────────────────── clap and snare ─────────────────────────── */

function writeClap(c: Ctx, m: Moment): void {
  const { cfg, parts: { family, fill, later } } = c;
  const { step, bar, s, sec, toHit, place: { act, phrase: n, at } } = m;
  if (inGap(c, m)) return;
  const feel = FEEL.clap;
  const play = (pitch: number, velocity: number, f: typeof feel = feel) => note(c, "drums", step, pitch, 1, vel(c, velocity), f);
  const rolled = { loose: 0.001, touch: 0.06 };

  if (m.pull && family.tension === "roll") {
    // quarters, then eighths, then 16ths, louder all the way into the hit
    const reach = m.pull.main ? Math.min(64, m.pull.to - m.pull.from) : Math.min(16, m.pull.to - m.pull.from);
    if (toHit <= reach) {
      const gap = toHit <= Math.min(8, reach / 2) ? 1 : toHit <= reach / 2 ? 2 : 4;
      if (toHit % gap === 0) play(40, 58 + 46 * (1 - toHit / reach), rolled);
      return;
    }
  }

  const playing = sec.kind === "break" ? through(m) >= 0.5
    : sec.kind === "outro" ? through(m) < 0.5
    : sec.kind === "build" || arrived(c, m, family.clapAt);
  if (!playing) return;

  // a phrase ends on a fill: always at eight bars, sometimes at four
  const phrase = bar % 8 === 7 || toHit <= 4;
  const turn = phrase || (bar % 4 === 3 && hitNoise(cfg.seed, bar, 11) < cfg.variation);
  if (turn && s >= 12) {
    const hit = fill[s - 12];
    if (hit !== ".") play(hit === "x" ? 38 : hit === "o" ? 39 : 37, 100 * LEVEL[hit] * (bar % 8 === 7 ? 1 : 0.8));
    return;
  }
  const simple = act === "beginning" || act === "outro" || m.bare;
  const developed = act === "end" && !m.bare && (at >= 4 || n % 4 === 3);
  const hit = hitAt(developed ? later.clap : c.parts.clap, step);
  if (simple && hit !== "x") return;
  // underneath nothing, the backbeat is what carries the pulse up to the hit
  const lift = sec.kind === "build" ? 0.8 + through(m) * 0.3 : sec.kind === "break" ? 0.7 : 1;
  if (hit !== ".") play(hit === "x" ? 38 : hit === "o" ? 39 : 37, 106 * LEVEL[hit] * lift);
  // at the end the main backbeat doubles up
  if (developed && hit === "x") play(39, 70);
}

/* ───────────────────────────── the tops ─────────────────────────────── */

function writeTops(c: Ctx, m: Moment): void {
  const { cfg, parts: { family, later } } = c;
  const { step, bar, s, sec, toHit, place: { act, phrase: n, at } } = m;
  const developed = act === "middle" ? n % 2 === 1 : act === "end" && (n % 2 === 1 || at >= 4);
  const hats = developed ? later.hats : c.parts.hats;
  if (inGap(c, m)) return;
  // some families drop the tops for the last beat, so they come back with the hit
  if (toHit <= 4 && (family.tension === "air" || family.tension === "roll")) return;
  if (sec.kind === "break" && through(m) < 0.5) return;

  if (m.pull && family.tension === "tops" && toHit <= (m.pull.main ? 32 : 16)) {
    const rise = 1 - toHit / (m.pull.main ? 32 : 16);
    if (toHit <= 8 || s % 2 === 0) note(c, "drums", step, s % 4 === 2 ? 46 : 42, 1, vel(c, 52 + rise * 52), FEEL.hat);
    return;
  }

  const main = sec.kind !== "intro" && !inBreak(m);
  const open = !m.bare && (sec.kind === "drop" || (main && act === "middle" && arrived(c, m, family.topsAt)));
  const opened = open ? hitAt(hats.open, step) : ".";
  if (opened !== ".") {
    note(c, "drums", step, 46, 2, vel(c, 92 * LEVEL[opened]), FEEL.open);
  } else {
    const hit = hitAt(hats.closed, step);
    // density fills in from the accents outwards
    const ranked = hit === "x" ? 0 : hit === "o" ? 0.25 : hit === "-" ? 0.4 : 0.8;
    const keep = ranked + hitNoise(laneSeed(cfg, "hats"), s, 6) * 0.3 < 0.15 + cfg.density * 0.8;
    const thin = s % 2 === 1 && ((act === "beginning" && n % 2 === 0) || m.bare || (act === "outro" && through(m) >= 0.5));
    if (keep && !thin) note(c, "drums", step, 42, 1, vel(c, hit === "." ? 40 : 100 * LEVEL[hit]), FEEL.hat);
  }

  const rideAt = family.ride ? 0.45 : 0.85;
  const riding = sec.kind === "drop" ? bar - sec.startBar < 8 || Math.floor((bar - sec.startBar) / 16) % 2 === 0
    : sec.kind === "riff" && family.ride && through(m) >= 0.5;
  if (riding && !m.pull && !m.bare && cfg.energy > rideAt && s % 2 === 0) note(c, "drums", step, 51, 2, vel(c, s % 4 === 2 ? 80 : 50), FEEL.ride);
}

/* ───────────────────────────── the idea ─────────────────────────────── */

function writeIdea(c: Ctx, m: Moment): void {
  const { cfg, parts: { family, idea, later } } = c;
  const { step, bar, s, sec, place: { act, phrase: n, at } } = m;
  const { lane, alt, lo, chord, length } = family.idea;
  // always the same first bar. What answers it grows as the track goes on
  const answering = !m.bare && at % 4 >= 2 && (
    act === "beginning" ? n % 2 === 1 && at >= 4
    : act === "middle" ? at >= 4 || n % 2 === 1
    : act === "end" && (at >= 4 || n > 0));
  let hit = hitAt(answering ? later.answers[act === "end" ? 1 : 0] : idea, step);
  if (hit === ".") return;
  const stated = act === "beginning" || act === "outro" || m.bare;
  if (stated) {
    // the bare call: no ghosts, no answering note
    if (hit === "-" || (hit === "o" && step % 32 >= 24)) return;
    if (hit === "h") hit = "o";
  }
  if (lane === "bass" && (m.low === "gone" || inBreak(m) || (sec.kind === "outro" && through(m) >= 0.5))) return;
  if (lane === "perc" && "tu".includes(hit) && m.low === "gone") return; // toms carry low end too
  if (sec.kind === "outro" && through(m) >= 0.75) return;
  // it stays the same idea, with another answer at the end of some phrases
  if (!stated && bar % 8 === 7 && s >= 8 && (hit === "o" || hit === "-") && hitNoise(laneSeed(cfg, lane), step, 4) < cfg.variation) hit = "h";

  const base = fold(lo + ((cfg.rootPitch - lo) % 12 + 12) % 12, lo, lo + 11);
  const velocity = vel(c, 110 * LEVEL[hit] * (sec.kind === "intro" ? 0.92 : 1));
  if (lane === "perc") {
    const pitch = hit === "t" ? PERC.toms[0] : hit === "u" ? PERC.toms[1] : hit === "h" ? PERC.hitB : PERC.hitA;
    note(c, lane, step, pitch, length, velocity, "tu".includes(hit) ? FEEL.tom : FEEL.perc);
  } else if (lane === "bass") {
    note(c, lane, step, base, length, velocity, FEEL.bass, { accent: hit === "x" });
  } else {
    const pitch = base + (hit === "h" ? alt : 0);
    note(c, lane, step, pitch, length, velocity, FEEL.synth, { accent: hit === "x" || hit === "h", ...(chord && { chord }) });
  }
}

/* ────────────────────────── around the idea ─────────────────────────── */

function writeSupport(c: Ctx, m: Moment): void {
  const { cfg, parts: { family, room, later } } = c;
  const { step, bar, s, sec, place: { act, phrase: n, at } } = m;
  const developed = act === "middle" ? n % 2 === 1 : act === "end" && (n % 2 === 1 || at >= 4);
  const bass = act === "end" && developed ? later.bass : c.parts.bass;
  const perc = developed ? later.perc : c.parts.perc;
  const sparse = act === "beginning" || act === "outro";
  const ending = sec.kind === "outro" ? through(m) : 0;

  if (bass && m.low === "full" && !inBreak(m) && ending < 0.5) {
    const hit = hitAt(bass, step);
    const held = sec.kind !== "intro" || through(m) >= 0.5;
    if (hit !== "." && held) {
      const root = fold(24 + cfg.rootPitch, 28, 39);
      note(c, "bass", step, root, hit === "x" ? 1.1 : 0.8, vel(c, 116 * LEVEL[hit]), FEEL.bass, { accent: hit === "x" });
    }
  }

  if (m.low === "gone" || inBreak(m) || ending >= 0.75 || m.bare) return;
  // in the middle of a track one layer rests for sixteen bars at a time
  const block = Math.floor(bar / 16);
  const rests = sec.kind === "riff" && hitNoise(cfg.seed, block, 12) < cfg.variation;

  if (!rests) {
    perc.forEach((line, i) => {
      if (!line || (sparse && i === 1) || room.has(step % 32)) return;
      const hit = hitAt(line, step);
      if (hit === ".") return;
      const n = hitNoise(laneSeed(cfg, "perc"), step, 5 + i);
      const turn = bar % 4 === 3 ? cfg.variation * 0.6 : cfg.variation * 0.08;
      if (n < turn || (i === 1 && n > 0.35 + cfg.density * 0.8)) return;
      note(c, "perc", step, i ? PERC.hitB : PERC.hitA, 1, vel(c, 92 * LEVEL[hit]), FEEL.perc);
    });
  }
  if (family.shaker && cfg.energy > 0.25 && !sparse && arrived(c, m, family.topsAt)) {
    const accent = [0.35, 0.5, 1, 0.65][s % 4];
    if (s % 2 === 0 || cfg.density > 0.35) note(c, "perc", step, PERC.shaker, 1, vel(c, 28 + accent * 58), FEEL.shaker);
  }
}

/* ─────────────────────────── breaks and hits ─────────────────────────── */

function writeEvents(c: Ctx): void {
  const { parts: { family, texture }, sections, pulls } = c;
  for (const sec of sections) {
    const step = sec.startBar * SPB;
    const length = sec.bars * SPB;
    if (sec.kind === "build") c.notes.push(fxNote(c, 1, step, length));
    if (sec.kind === "drop") {
      c.notes.push(fxNote(c, 2, step, SPB));
      note(c, "drums", step, 49, 16, vel(c, 92));
    }
    if (sec.kind === "break") {
      c.notes.push(fxNote(c, 3, step, length));
      if (family.idea.lane !== "pad") note(c, "pad", step, fold(48 + c.cfg.rootPitch, 48, 59), length, vel(c, 92), {}, { variant: texture });
    }
  }
  for (const p of pulls) {
    if (p.main) continue;
    const length = p.to - p.from;
    if (length >= 4 && family.tension === "air") c.notes.push(fxNote(c, 4, p.from, length));
    // the one after a longer wind-down is marked, softly
    if (length >= 16 && p.to < c.bars * SPB && !sections.some((s) => s.kind === "drop" && s.startBar * SPB === p.to)) {
      note(c, "drums", p.to, 49, 16, vel(c, 76));
    }
  }
}

/* ────────────────────────────── the moves ───────────────────────────── */

export function grooveMoves(sections: Section[], pulls: Pull[], stepSec: number, mix: MixParams): Automation[] {
  const barSec = stepSec * SPB;
  const space = 0.2 + mix.space * 0.65;
  const echo = 0.25 + mix.echo * 0.34;
  const at: Record<Automation["param"], number> = { cutoff: 2000, space, echo, acid: 1, low: 1 };
  const out: Automation[] = (["cutoff", "space", "echo", "low"] as const).map((param) => ({ time: 0, param, from: at[param], value: at[param], ramp: 0 }));
  const move = (time: number, param: Automation["param"], value: number, ramp: number) => {
    out.push({ time, param, from: at[param], value, ramp });
    at[param] = value;
  };

  for (const s of sections) {
    const t = s.startBar * barSec;
    const len = s.bars * barSec;
    if (s.kind === "break") move(t, "cutoff", 3500, Math.min(barSec, len));
    else if (s.kind === "build") move(t, "cutoff", 16000, len);
    else if (s.kind === "outro") move(t, "cutoff", 1700, len);
    else if (s.kind === "drop") move(t, "cutoff", 13000, 0.02);
    // the idea starts behind a filter and opens through the middle
    else move(t, "cutoff", s.kind === "intro" ? 2500 : s.kind === "groove" ? 4500 : 7500, len);
  }
  for (const p of pulls) {
    const from = p.from * stepSec;
    // multiplied as whole bars, so a loop that starts on the hit finds this move
    const to = p.to % SPB === 0 ? (p.to / SPB) * barSec : p.to * stepSec;
    move(p.gone * stepSec, "low", 0, 0.03);
    move(to, "low", 1, 0);
    // the room swells as the floor leaves, and shuts as it lands
    move(from, "space", clamp(space + (p.main ? 0.25 : 0.12), 0, 0.95), to - from - 0.01);
    move(to, "space", space, 0);
    if (p.main) {
      move(from, "echo", Math.min(0.62, echo + 0.14), to - from - 0.01);
      move(to, "echo", echo, 0);
    }
  }
  return out.sort((a, b) => a.time - b.time);
}
