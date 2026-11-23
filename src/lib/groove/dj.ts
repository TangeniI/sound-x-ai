/**
 * lib/groove/dj.ts
 *
 * The DJ version of a Groove: 32 bars of drums alone at each end, so a DJ has
 * room to mix in and out. Kick and hats come first, then the whole kit; the outro
 * runs the other way. The rumble stays shut in those bars, so the low end doesn't
 * clash with the record it's mixed against. Everything stays in multiples of eight.
 */

import type { Automation, NoteEvent, Section } from "../../types";

const SPB = 16;
/** Bars of drums alone at each end. */
export const DJ_BARS = 32;
const HALF = DJ_BARS / 2;
const SOURCE_BARS = 8;

const KICK = new Set([35, 36]);
const CLOSED = 42;

interface Parts {
  notes:      NoteEvent[];
  sections:   Section[];
  automation: Automation[];
  endKit:     { from: number; kit: unknown };
  stepSec:    number;
}

/** Eight bars of the track's own drums to loop: its first full groove, else its first eight bars. */
function sourceBars(notes: NoteEvent[], sections: Section[], from: "start" | "end"): NoteEvent[] {
  const body = sections.filter((s) => s.kind === "groove" || s.kind === "riff" || s.kind === "drop");
  const pick = from === "start" ? body[0] : body[body.length - 1];
  const first = pick ? (from === "start" ? pick.startBar : pick.startBar + pick.bars - SOURCE_BARS) : 0;
  const lo = Math.max(0, first) * SPB;
  return notes.filter((n) => n.instrument === "drums" && n.step >= lo && n.step < lo + SOURCE_BARS * SPB && n.pitch !== 49);
}

/** Copy eight bars of drums over `bars` bars starting at `atBar`, keeping only what `keep` lets through. */
function loopDrums(source: NoteEvent[], atBar: number, bars: number, barSec: number, keep: (n: NoteEvent, bar: number) => boolean): NoteEvent[] {
  if (!source.length) return [];
  const firstBar = Math.floor(Math.min(...source.map((n) => n.step)) / SPB);
  const out: NoteEvent[] = [];
  for (let bar = 0; bar < bars; bar++) {
    const src = firstBar + (bar % SOURCE_BARS);
    const shift = atBar + bar - src;
    for (const n of source) {
      if (Math.floor(n.step / SPB) !== src || !keep(n, bar)) continue;
      out.push({ ...n, step: n.step + shift * SPB, startTime: n.startTime + shift * barSec, endTime: n.endTime + shift * barSec });
    }
  }
  return out;
}

export function djVersion<P extends Parts>(parts: P): P & { offsetSteps: number; totalBars: number } {
  const { notes, sections, automation, endKit, stepSec } = parts;
  const barSec = stepSec * SPB;
  const bodyBars = sections.reduce((n, s) => Math.max(n, s.startBar + s.bars), 0);
  const off = DJ_BARS * barSec;
  const offsetSteps = DJ_BARS * SPB;
  const endBar = DJ_BARS + bodyBars;
  const end = endBar * barSec;

  const pulse = (n: NoteEvent) => KICK.has(n.pitch) || n.pitch === CLOSED;
  const intro = loopDrums(sourceBars(notes, sections, "start"), 0, DJ_BARS, barSec, (n, bar) => bar >= HALF || pulse(n));
  const outro = loopDrums(sourceBars(notes, sections, "end"), endBar, DJ_BARS, barSec, (n, bar) => bar < HALF || pulse(n));
  const body = notes.map((n) => ({ ...n, step: n.step + offsetSteps, startTime: n.startTime + off, endTime: n.endTime + off }));

  // the track's opening mix holds through the intro, with the rumble shut
  const opening = automation.filter((a) => a.time === 0 && a.param !== "low");
  const moves: Automation[] = [
    ...opening,
    { time: 0, param: "low" as const, from: 0, value: 0, ramp: 0 },
    ...automation.map((a) => ({ ...a, time: a.time + off })),
    { time: off, param: "low" as const, from: 0, value: 1, ramp: 0.02 },
    { time: end - 0.02, param: "low" as const, from: 1, value: 0, ramp: 0.02 },
  ].sort((a, b) => a.time - b.time);

  return {
    ...parts,
    notes: [...intro, ...body, ...outro].sort((a, b) => a.startTime - b.startTime),
    sections: [
      { kind: "intro", startBar: 0, bars: DJ_BARS },
      ...sections.map((s) => ({ ...s, startBar: s.startBar + DJ_BARS })),
      { kind: "outro", startBar: endBar, bars: DJ_BARS },
    ],
    automation: moves,
    endKit: { ...endKit, from: endKit.from + offsetSteps },
    offsetSteps,
    totalBars: endBar + DJ_BARS,
  };
}
