import { readFileSync } from "node:fs";
import { beforeAll, describe, it, expect } from "vitest";
import { arrange, DEFAULT_CONFIG, euclid, featuresFromConfig, generativeEngine, LENGTHS } from "./generative-engine";
import { neuralRiff, type ModelJSON } from "./neural-engine";
import type { GeneratorConfig, Lane, StyleId } from "../types";

const base: GeneratorConfig = { ...DEFAULT_CONFIG, bars: 64 };
const STYLES: StyleId[] = ["driving", "hypnotic", "acid", "melodic", "dub", "warehouse"];
const gen = (over: Partial<GeneratorConfig> = {}) => generativeEngine.generate({ ...base, ...over });
const lane = (t: ReturnType<typeof gen>, l: string) => t.notes.filter((n) => n.instrument === l);
const pitches = (t: ReturnType<typeof gen>, l: string) => lane(t, l).map((n) => `${n.step}:${n.pitch}`);

beforeAll(() => {
  neuralRiff.use(JSON.parse(readFileSync("public/model/riff-gru.json", "utf8")) as ModelJSON);
});

describe("takes and seeds", () => {
  it("is deterministic for a config and seed", () => {
    expect(gen().notes).toEqual(gen().notes);
  });

  it("writes a different track for a different seed", () => {
    expect(pitches(gen({ seed: 1 }), "lead")).not.toEqual(pitches(gen({ seed: 2 }), "lead"));
  });

  it("re-rolling one lane leaves the others alone", () => {
    const a = gen();
    const b = gen({ laneSeeds: { bass: 7 } });
    expect(pitches(a, "bass")).not.toEqual(pitches(b, "bass"));
    for (const other of ["drums", "stab", "lead", "perc"] as Lane[]) expect(pitches(a, other)).toEqual(pitches(b, other));
  });

  it("moving a slider shapes the take instead of replacing it", () => {
    const a = gen({ valence: 0.42 });
    const b = gen({ energy: 0.8, variation: 0.35 });
    expect(a.riff.tokens).toEqual(b.riff.tokens);
  });
});

describe("controls change the music", () => {
  it("energy changes the drums, the mix and the ride", () => {
    const quiet = gen({ energy: 0.1 });
    const loud = gen({ energy: 0.95 });
    const mean = (t: ReturnType<typeof gen>) => {
      const d = lane(t, "drums");
      return d.reduce((a, n) => a + n.velocity, 0) / d.length;
    };
    expect(mean(loud)).toBeGreaterThan(mean(quiet) + 10);
    expect(lane(loud, "drums").filter((n) => n.pitch === 51).length).toBeGreaterThan(0);
    expect(lane(quiet, "drums").filter((n) => n.pitch === 51).length).toBe(0);
    expect(loud.mix.drive).toBeGreaterThan(quiet.mix.drive);
    expect(loud.mix.rumble).toBeGreaterThan(quiet.mix.rumble);
  });

  it("density adds hats", () => {
    const count = (t: ReturnType<typeof gen>) => lane(t, "drums").filter((n) => n.pitch === 42).length;
    expect(count(gen({ density: 1 }))).toBeGreaterThan(count(gen({ density: 0.1 })));
  });

  it("mood changes the scale, and major keys are available", () => {
    expect(gen({ valence: 0.1 }).scale).not.toEqual(gen({ valence: 0.5 }).scale);
    expect(gen({ mode: "major" }).tonality).toBe("major");
  });

  it("tunes the kick to the key", () => {
    const tunes = new Set(Array.from({ length: 12 }, (_, rootPitch) => gen({ rootPitch }).mix.kickTune));
    expect(tunes.size).toBeGreaterThan(3);
    for (const t of tunes) expect(Math.abs(t)).toBeLessThanOrEqual(6);
  });
});

describe("arrangement", () => {
  it("adds up to the requested length", () => {
    for (const bars of LENGTHS) expect(arrange(bars).reduce((n, s) => n + s.bars, 0)).toBe(bars);
  });

  it("every riser lands on a drop, at every length", () => {
    for (const bars of LENGTHS) {
      const t = gen({ bars });
      const risers = lane(t, "fx").filter((n) => n.pitch === 1);
      const impacts = lane(t, "fx").filter((n) => n.pitch === 2);
      expect(risers.length).toBeGreaterThan(0);
      for (const r of risers) {
        expect(impacts.some((i) => Math.abs(i.startTime - r.endTime) < 1e-6)).toBe(true);
      }
    }
  });

  it("takes the kick away in the break and brings it back for the drop", () => {
    const t = gen();
    const brk = t.sections.find((s) => s.kind === "break")!;
    const drop = t.sections.find((s) => s.kind === "drop")!;
    const kicksIn = (s: typeof brk) => t.notes.filter((n) => n.pitch === 36 && n.instrument === "drums" && n.step >= s.startBar * 16 && n.step < (s.startBar + s.bars) * 16).length;
    expect(kicksIn(brk)).toBe(0);
    expect(kicksIn(drop)).toBeGreaterThanOrEqual(drop.bars * 4);
  });

  it("gives a track real length", () => {
    expect(gen({ bars: 32, tempo: 132 }).durationSec).toBeGreaterThan(40);
    expect(gen({ bars: 128, tempo: 132 }).durationSec).toBeGreaterThan(170);
  });
});

describe("every style", () => {
  for (const style of STYLES) {
    it(`${style} writes in range, in order, with a full band`, () => {
      const t = gen({ style });
      for (const l of ["drums", "bass", "lead", "perc"]) expect(lane(t, l).length).toBeGreaterThan(0);
      for (const n of t.notes) {
        expect(n.pitch).toBeGreaterThanOrEqual(0);
        expect(n.pitch).toBeLessThanOrEqual(127);
        expect(n.endTime).toBeGreaterThan(n.startTime);
        expect(n.velocity).toBeGreaterThanOrEqual(1);
        expect(n.velocity).toBeLessThanOrEqual(127);
      }
      const times = t.notes.map((n) => n.startTime);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      for (const n of lane(t, "bass")) expect(n.pitch).toBeLessThanOrEqual(50);
    });
  }

  it("keeps bass notes off the kicks in the rolling style", () => {
    const t = gen({ style: "driving" });
    for (const n of lane(t, "bass")) expect(n.step % 4).not.toBe(0);
  });
});

describe("piano-roll edits", () => {
  it("survive regeneration and tempo changes", () => {
    const first = lane(gen(), "lead")[0];
    const edits = [
      { op: "remove" as const, lane: "lead" as Lane, step: first.step, pitch: first.pitch },
      { op: "add" as const, lane: "bass" as Lane, step: 8, pitch: 40 },
    ];
    const t = generativeEngine.generate({ ...base, tempo: 140 }, edits);
    expect(t.notes.some((n) => n.instrument === "lead" && n.step === first.step && n.pitch === first.pitch)).toBe(false);
    expect(t.notes.some((n) => n.instrument === "bass" && n.step === 8 && n.pitch === 40)).toBe(true);
  });
});

describe("helpers", () => {
  it("spreads Euclidean hits evenly", () => {
    expect(euclid(4, 16).filter(Boolean)).toHaveLength(4);
    expect(euclid(4, 16)).toEqual([true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false]);
    expect(euclid(5, 16, 3).filter(Boolean)).toHaveLength(5);
  });

  it("seeds visual features from controls", () => {
    const f = featuresFromConfig(base);
    expect(f.tempo).toBe(base.tempo);
    expect(f.danceability).toBe(base.density);
  });
});
