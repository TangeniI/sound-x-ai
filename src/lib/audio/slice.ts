/**
 * lib/audio/slice.ts
 *
 * Cuts bars out of a track as a track of their own, for loop exports, and splits
 * a track into the stems a producer would want. Pure, so it's tested without audio.
 */

import type { Automation, NoteEvent, Section, Track } from "../../types";
import type { ChannelId } from "./graph";

const SPB = 16;

/** Where a mix move stands at `time`: held, or part way through a ramp. */
function stateAt(moves: Automation[], param: Automation["param"], time: number): Automation | null {
  let prior: Automation | null = null;
  for (const a of moves) if (a.param === param && a.time <= time) prior = a;
  if (!prior) return null;
  const left = prior.time + prior.ramp - time;
  if (left <= 0) return { param, time: 0, from: prior.value, value: prior.value, ramp: 0 };
  const done = prior.ramp ? (time - prior.time) / prior.ramp : 1;
  const now = param === "cutoff" ? prior.from * (prior.value / prior.from) ** done : prior.from + (prior.value - prior.from) * done;
  return { param, time: 0, from: now, value: prior.value, ramp: left };
}

/**
 * Bars [startBar, startBar + bars) as their own track, played `passes` times in a
 * row. Each pass starts from the mix as it stood at the first bar, as the player
 * does when it loops. Render two passes and keep the second, and the reverb and
 * echo coming round from the end are already there at the start: a seamless loop.
 */
export function sliceTrack(track: Track, startBar: number, bars: number, passes = 1): Track {
  const barSec = track.stepSec * SPB;
  const t0 = startBar * barSec;
  const len = bars * barSec;
  const first = startBar * SPB;
  const steps = bars * SPB;

  const inside = track.notes.filter((n) => n.step >= first && n.step < first + steps);
  const params = [...new Set(track.automation.map((a) => a.param))];
  const notes: NoteEvent[] = [];
  const automation: Automation[] = [];
  const sections: Section[] = [];
  for (let p = 0; p < passes; p++) {
    const dt = p * len - t0;
    for (const n of inside) notes.push({ ...n, step: n.step - first + p * steps, startTime: n.startTime + dt, endTime: n.endTime + dt });
    for (const param of params) {
      const held = stateAt(track.automation, param, t0);
      if (held) automation.push({ ...held, time: p * len });
    }
    for (const a of track.automation) if (a.time > t0 && a.time < t0 + len) automation.push({ ...a, time: a.time + dt });
    for (const s of track.sections) {
      const from = Math.max(s.startBar, startBar);
      const to = Math.min(s.startBar + s.bars, startBar + bars);
      if (to > from) sections.push({ kind: s.kind, startBar: from - startBar + p * bars, bars: to - from });
    }
  }
  notes.sort((a, b) => a.startTime - b.startTime);
  automation.sort((a, b) => a.time - b.time);

  // the sounds a Groove switches to at its first drop. A loop that crosses the
  // switch gets it right in its last pass, the one that's kept
  let { kit, endKit } = track;
  if (endKit) {
    const at = endKit.from - first;
    if (at <= 0) [kit, endKit] = [endKit.kit, undefined];
    else if (at >= steps) endKit = undefined;
    else endKit = { kit: endKit.kit, from: at + (passes - 1) * steps };
  }
  return { ...track, notes, automation, sections, kit, endKit, durationSec: len * passes };
}

/* ─────────────────────────────── stems ──────────────────────────────── */

const isKick = (n: NoteEvent) => n.instrument === "drums" && (n.pitch === 35 || n.pitch === 36);
const CLAPS = new Set([37, 38, 39, 40]);

export interface Stem {
  name:  string;
  /** The channels this stem plays through. */
  only:  ChannelId[];
  notes: (n: NoteEvent) => boolean;
}

/**
 * Split by what a producer swaps or processes first: the kick on its own, then the
 * backbeat, the cymbals, percussion, the low end, the musical parts and effects.
 */
export const STEMS: Stem[] = [
  { name: "kick", only: ["drums"], notes: isKick },
  { name: "clap-snare", only: ["drums"], notes: (n) => n.instrument === "drums" && CLAPS.has(n.pitch) },
  { name: "hats-cymbals", only: ["drums"], notes: (n) => n.instrument === "drums" && !isKick(n) && !CLAPS.has(n.pitch) },
  { name: "perc", only: ["perc"], notes: (n) => n.instrument === "perc" },
  { name: "low-end", only: ["bass", "rumble"], notes: (n) => n.instrument === "bass" },
  { name: "music", only: ["stab", "pad", "lead"], notes: (n) => n.instrument === "stab" || n.instrument === "pad" || n.instrument === "lead" },
  { name: "fx", only: ["fx"], notes: (n) => n.instrument === "fx" },
];

/**
 * One stem's track. The kicks stay in every stem, because they drive the sidechain
 * pump and the rumble. Where the kick's own channel plays, they're silent.
 */
export function stemTrack(track: Track, stem: Stem): Track {
  const kickHeard = stem.name === "kick";
  const kicksSound = stem.only.includes("drums");
  const notes = track.notes.flatMap((n) => {
    if (stem.notes(n)) return [n];
    if (isKick(n)) return [kicksSound && !kickHeard ? { ...n, velocity: 0 } : n];
    return [];
  });
  return { ...track, notes };
}

/** The stems with something in them that mute and solo leave playing. */
export function stemsFor(track: Track, audible: ReadonlySet<ChannelId>): Stem[] {
  return STEMS.filter((s) => s.only.some((c) => audible.has(c)) && (s.name === "fx" || track.notes.some(s.notes)));
}
