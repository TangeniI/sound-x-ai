/**
 * lib/groove/flow.ts
 *
 * How a Groove track winds down and hits. In the records studied, the impact is
 * contrast: the low end leaves at the end of a phrase while the idea carries on,
 * then it all returns exactly on the one at its usual level. The pulls grow from
 * a beat to a bar to two bars, and once per track to a full break.
 */

import { hitNoise } from "../writing";
import type { GeneratorConfig, Section, SectionKind } from "../../types";
import type { Family } from "./families";

type Layout = [SectionKind, number][];

const LAYOUTS: Record<number, Layout[]> = {
  16: [
    [["groove", 4], ["break", 2], ["build", 2], ["drop", 8]],
    [["groove", 5], ["break", 1], ["build", 2], ["drop", 8]],
    [["intro", 2], ["groove", 3], ["break", 1], ["build", 2], ["drop", 8]],
  ],
  32: [
    [["intro", 4], ["groove", 8], ["break", 2], ["build", 2], ["drop", 12], ["outro", 4]],
    [["groove", 8], ["riff", 4], ["break", 2], ["build", 2], ["drop", 12], ["outro", 4]],
    [["groove", 12], ["break", 4], ["build", 4], ["drop", 8], ["outro", 4]],
  ],
  64: [
    [["intro", 8], ["groove", 16], ["riff", 8], ["break", 4], ["build", 4], ["drop", 16], ["outro", 8]],
    [["groove", 16], ["riff", 16], ["break", 4], ["build", 4], ["drop", 16], ["outro", 8]],
    [["groove", 16], ["riff", 8], ["break", 4], ["build", 4], ["drop", 24], ["outro", 8]],
  ],
  96: [
    [["intro", 8], ["groove", 16], ["riff", 16], ["break", 8], ["build", 8], ["drop", 32], ["outro", 8]],
    [["groove", 16], ["riff", 32], ["break", 4], ["build", 4], ["drop", 32], ["outro", 8]],
    [["intro", 16], ["groove", 16], ["riff", 16], ["break", 8], ["build", 8], ["drop", 24], ["outro", 8]],
  ],
  128: [
    [["intro", 16], ["groove", 16], ["riff", 24], ["break", 8], ["build", 8], ["drop", 40], ["outro", 16]],
    [["groove", 32], ["riff", 32], ["break", 8], ["build", 8], ["drop", 32], ["outro", 16]],
    [["intro", 8], ["groove", 24], ["riff", 32], ["break", 4], ["build", 4], ["drop", 40], ["outro", 16]],
  ],
  176: [
    [["intro", 16], ["groove", 32], ["riff", 40], ["break", 8], ["build", 8], ["drop", 56], ["outro", 16]],
    [["groove", 32], ["riff", 48], ["break", 8], ["build", 8], ["drop", 32], ["break", 4], ["build", 4], ["drop", 24], ["outro", 16]],
    [["intro", 16], ["groove", 32], ["riff", 48], ["break", 4], ["build", 4], ["drop", 56], ["outro", 16]],
  ],
};

/** `cfg.bars` is one of the lengths the engine offers. */
export function grooveSections(cfg: GeneratorConfig, bars: number): Section[] {
  const options = LAYOUTS[bars];
  const layout = options[Math.floor(hitNoise(cfg.seed, bars, 31) * options.length)];
  let at = 0;
  return layout.map(([kind, length]) => {
    const section = { kind, startBar: at, bars: length };
    at += length;
    return section;
  });
}

export type Act = "beginning" | "middle" | "end" | "outro";

export interface Place {
  act:    Act;
  /** Eight-bar phrases since the act or drop began. */
  phrase: number;
  /** The bar within that phrase. */
  at:     number;
}

/**
 * Where a bar sits in the story. The beginning states the idea, the middle opens
 * and answers it, the end starts on the first drop and the outro goes back to
 * how it began.
 */
export function placeOf(sections: Section[], bar: number): Place {
  const sec = sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars)!;
  const groove = sections.find((s) => s.kind === "groove")!;
  const riff = sections.find((s) => s.kind === "riff");
  const half = groove.bars >= 8 ? Math.ceil(groove.bars / 8) * 4 : Math.ceil(groove.bars / 2);
  const middle = riff?.startBar ?? groove.startBar + half;
  const end = sections.find((s) => s.kind === "drop")!.startBar;

  const act: Act = sec.kind === "outro" ? "outro" : bar >= end ? "end" : bar >= middle ? "middle" : "beginning";
  const since = bar - (act === "middle" ? middle : act === "beginning" ? 0 : sec.startBar);
  return { act, phrase: Math.floor(since / 8), at: since % 8 };
}

/** A stretch before a hit where the floor goes. Steps are absolute, `to` is the one. */
export interface Pull {
  from:  number; // where it starts to thin or go
  gone:  number; // from here there is no low end at all
  to:    number;
  main:  boolean; // the break, as opposed to a phrase end
}

/**
 * Where the low end leaves. The last beat before every hit is always empty
 * underneath, even where the bars before it only thin out.
 */
export function pullsFor(cfg: GeneratorConfig, family: Family, sections: Section[], bars: number): Pull[] {
  const out: Pull[] = [];
  let breakStart = -1;
  for (const s of sections) {
    if (s.kind === "break" && breakStart < 0) breakStart = s.startBar;
    if (s.kind === "drop" && breakStart >= 0) {
      out.push({ from: breakStart * 16, gone: breakStart * 16, to: s.startBar * 16, main: true });
      breakStart = -1;
    }
  }

  const loopEnd = loopBars(sections).end;
  const held = (bar: number) => {
    const kind = sections.find((s) => bar >= s.startBar && bar < s.startBar + s.bars)?.kind;
    return kind === "break" || kind === "build" || kind === "outro";
  };
  for (let end = 1; end <= bars; end++) {
    const isLoop = end === loopEnd;
    if (end % 8 !== 0 && !isLoop) continue;
    // a break is its own wind-down, and the outro only sheds layers
    if (held(end - 1) || (!isLoop && end < bars && sections.some((s) => s.kind === "break" && s.startBar === end))) continue;

    let beats = 1;
    if (isLoop) {
      beats = family.turn;
    } else if (end % 32 === 0) {
      beats = cfg.variation < 0.2 ? 4 : 8;
    } else if (end % 16 === 0) {
      beats = 4;
    } else if (hitNoise(cfg.seed, end, 32) < cfg.variation * 0.6) {
      beats = 2;
    }
    const to = end * 16;
    const from = to - beats * 4;
    out.push({ from, gone: family.pull === "thin" ? to - 4 : from, to, main: false });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The eight bars Randomise opens on: the first full drop, with its turnaround. */
export function loopBars(sections: Section[]): { start: number; end: number } {
  const last = sections[sections.length - 1];
  const drop = sections.find((s) => s.kind === "drop") ?? last;
  return { start: drop.startBar, end: Math.min(drop.startBar + 8, last.startBar + last.bars) };
}
