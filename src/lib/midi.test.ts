import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, generativeEngine } from "./generative-engine";
import { CHANNELS, clockTick, noteMessages, songPosition } from "./midi";
import type { NoteEvent } from "../types";

const note = (over: Partial<NoteEvent>): NoteEvent => ({ pitch: 36, step: 0, startTime: 0, endTime: 0.1, velocity: 100, instrument: "drums", ...over });

describe("MIDI out", () => {
  it("sends drums on the GM drum channel, short, at the note's time", () => {
    const [on, off] = noteMessages(note({}), 1.5);
    expect(on).toEqual({ data: [0x99, 36, 100], time: 1.5 });
    expect(off.data).toEqual([0x89, 36, 0]);
    expect(off.time).toBeCloseTo(1.56, 9);
  });

  it("plays a stab's whole chord, held for the note's length", () => {
    const m = noteMessages(note({ instrument: "stab", pitch: 57, chord: [0, 7, 12], startTime: 2, endTime: 2.5 }), 2);
    expect(m.filter((x) => (x.data[0] & 0xf0) === 0x90).map((x) => x.data[1])).toEqual([57, 64, 69]);
    expect(m.every((x) => (x.data[0] & 0x0f) === CHANNELS.stab)).toBe(true);
    expect(Math.max(...m.map((x) => x.time))).toBeCloseTo(2.495, 9);
  });

  it("keeps velocity in range, and leaves out effects", () => {
    expect(noteMessages(note({ velocity: 0 }), 0)[0].data[2]).toBe(1);
    expect(noteMessages(note({ velocity: 300 }), 0)[0].data[2]).toBe(127);
    expect(noteMessages(note({ instrument: "fx" }), 0)).toEqual([]);
  });

  it("counts song position in 16ths and clock at 24 a beat", () => {
    const stepSec = 60 / 138 / 4;
    expect(songPosition(0, stepSec)).toEqual([0xf2, 0, 0]);
    expect(songPosition(40 * 16 * stepSec, stepSec)).toEqual([0xf2, 640 & 0x7f, 640 >> 7]); // bar 41
    expect(clockTick(stepSec) * 24).toBeCloseTo(60 / 138, 12);
  });

  it("covers every note a track writes, on a channel an instrument can take", () => {
    const t = generativeEngine.generate(DEFAULT_CONFIG);
    const sent = t.notes.flatMap((n) => noteMessages(n, n.startTime));
    expect(sent.length).toBeGreaterThan(t.notes.filter((n) => n.instrument !== "fx").length);
    for (const m of sent) {
      expect(m.data[1]).toBeGreaterThanOrEqual(0);
      expect(m.data[1]).toBeLessThanOrEqual(127);
    }
  });
});
