import { describe, it, expect } from "vitest";
import { generativeEngine, featuresFromConfig } from "./generative-engine";
import type { GeneratorConfig } from "../types";

const base: GeneratorConfig = {
  style: "driving", bars: 8, tempo: 128, energy: 0.7, valence: 0.4,
  density: 0.65, variation: 0.3, rootPitch: 9, seedFromAudio: false,
};

describe("generative engine", () => {
  it("is deterministic for a given config", () => {
    const a = generativeEngine.generate(base, null);
    const b = generativeEngine.generate(base, null);
    expect(a).toEqual(b);
  });

  it("produces every instrument lane for a full style", () => {
    const notes = generativeEngine.generate(base, null);
    const insts = new Set(notes.map((n) => n.instrument));
    expect(insts.has("bass")).toBe(true);
    expect(insts.has("drums")).toBe(true);
    expect(insts.has("lead")).toBe(true);
    expect(insts.has("stab")).toBe(true);
  });

  it("keeps the rolling bass off the kick downbeats (the pump)", () => {
    const notes = generativeEngine.generate(base, null);
    const stepSec = 60 / base.tempo / 4;
    const kickSteps = notes
      .filter((n) => n.instrument === "drums" && n.pitch === 36)
      .map((n) => Math.round(n.startTime / stepSec) % 16);
    const bassSteps = notes
      .filter((n) => n.instrument === "bass")
      .map((n) => Math.round(n.startTime / stepSec) % 16);
    // no rolling-bass note shares a downbeat (0,4,8,12) with a kick
    for (const s of [0, 4, 8, 12]) {
      if (kickSteps.includes(s)) expect(bassSteps).not.toContain(s);
    }
  });

  it("scales note count with bar length", () => {
    const short = generativeEngine.generate({ ...base, bars: 4 }, null);
    const long = generativeEngine.generate({ ...base, bars: 16 }, null);
    expect(long.length).toBeGreaterThan(short.length);
  });

  it("produces different output for different styles", () => {
    const driving = generativeEngine.generate({ ...base, style: "driving" }, null);
    const hypnotic = generativeEngine.generate({ ...base, style: "hypnotic" }, null);
    expect(driving.length).not.toEqual(hypnotic.length);
  });

  it("keeps every note within a sane MIDI range and ordered by time", () => {
    const notes = generativeEngine.generate(base, null);
    for (const n of notes) {
      expect(n.pitch).toBeGreaterThanOrEqual(0);
      expect(n.pitch).toBeLessThanOrEqual(127);
      expect(n.endTime).toBeGreaterThan(n.startTime);
    }
    const times = notes.map((n) => n.startTime);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("seeds visual features from controls", () => {
    const f = featuresFromConfig(base);
    expect(f.tempo).toBe(128);
    expect(f.energy).toBe(0.7);
    expect(f.danceability).toBe(base.density);
  });
});
