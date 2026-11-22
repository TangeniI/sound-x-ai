import { readFileSync } from "node:fs";
import { beforeAll, describe, it, expect } from "vitest";
import { arrange, DEFAULT_CONFIG, euclid, generativeEngine, LENGTHS } from "./generative-engine";
import { familyById } from "./groove/families";
import { neuralRiff, type ModelJSON } from "./neural-engine";
import type { GeneratorConfig, Lane, StyleId } from "../types";

const base: GeneratorConfig = { ...DEFAULT_CONFIG, bars: 64 };
const STYLES: StyleId[] = ["driving", "hypnotic", "acid", "tribal", "dub", "warehouse"];
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
    expect(pitches(gen({ style: "hypnotic", seed: 1 }), "lead")).not.toEqual(pitches(gen({ style: "hypnotic", seed: 2 }), "lead"));
    const whole = (seed: number) => gen({ seed }).notes.map((n) => `${n.instrument}:${n.step}:${n.pitch}`);
    expect(whole(1)).not.toEqual(whole(2));
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
    expect(kicksIn({ ...drop, bars: 1 })).toBeGreaterThanOrEqual(4); // all of it, straight away
    expect(kicksIn(drop)).toBeGreaterThanOrEqual(drop.bars * 4 * 0.8); // bar the wind-downs inside it
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
      const band = t.family ? ["drums", "bass", "perc", familyById(t.family.id)!.idea.lane] : ["drums", "bass", "lead", "perc"];
      for (const l of band) expect(lane(t, l).length).toBeGreaterThan(0);
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
    const hypnotic = { ...base, style: "hypnotic" as const };
    const first = lane(gen(hypnotic), "lead")[0];
    const edits = [
      { op: "remove" as const, lane: "lead" as Lane, step: first.step, pitch: first.pitch },
      { op: "add" as const, lane: "bass" as Lane, step: 8, pitch: 40 },
    ];
    const t = generativeEngine.generate({ ...hypnotic, tempo: 140 }, edits);
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
});
const pc = (p: number) => ((p % 12) + 12) % 12;

describe("in key, in every style and key", () => {
  for (const style of STYLES) {
    for (const valence of [0.1, 0.5, 0.75]) {
      it(`${style} at light ${valence}`, () => {
        for (let rootPitch = 0; rootPitch < 12; rootPitch++) {
          for (const mode of ["auto", "major"] as const) {
            const t = gen({ style, rootPitch, valence, mode });
            for (const n of t.notes.filter((x) => ["bass", "lead", "stab", "pad"].includes(x.instrument))) {
              for (const off of n.chord ?? [0]) expect(t.scale).toContain(pc(n.pitch + off - rootPitch));
            }
            const bass = lane(t, "bass");
            const onRoot = bass.filter((n) => pc(n.pitch) === rootPitch).length;
            // a 303 line wanders, every other bass sits on the tonic
            if (style === "acid") expect(onRoot).toBeGreaterThan(0);
            else expect(onRoot / bass.length).toBeGreaterThan(0.5);
          }
        }
      });
    }
  }

  it("never turns the bass into a melody, outside the 303", () => {
    for (const style of ["driving", "hypnotic", "tribal", "dub", "warehouse"] as const) {
      for (const rootPitch of [0, 4, 9]) {
        for (const n of lane(gen({ style, rootPitch }), "bass")) expect(n.pitch % 12).toBe(rootPitch);
      }
    }
  });

  it("keeps every stab off the kick", () => {
    for (const style of ["driving", "hypnotic", "tribal", "dub", "warehouse"] as const) {
      for (let seed = 1; seed < 25; seed++) {
        for (const n of lane(gen({ style, seed }), "stab")) expect(n.step % 4).not.toBe(0);
      }
    }
  });

  it("only puts a third in the Dub stab", () => {
    for (const style of ["driving", "hypnotic", "tribal", "warehouse"] as const) {
      for (const n of lane(gen({ style }), "stab")) for (const off of n.chord ?? [0]) expect([0, 7]).toContain(off % 12);
    }
  });

  it("keeps every bass but the 303 in the E1 to D#2 octave", () => {
    for (const style of STYLES.filter((s) => s !== "acid")) {
      for (let rootPitch = 0; rootPitch < 12; rootPitch++) {
        for (const n of lane(gen({ style, rootPitch }), "bass")) {
          expect(n.pitch).toBeGreaterThanOrEqual(28);
          expect(n.pitch).toBeLessThanOrEqual(39);
        }
      }
    }
  });
});

describe("groove", () => {
  const t = gen();
  const offset = (n: { step: number; startTime: number }) => n.startTime - n.step * t.stepSec;

  it("puts every kick on the grid", () => {
    for (const n of lane(t, "drums").filter((x) => x.pitch === 36)) expect(Math.abs(offset(n))).toBeLessThan(1e-9);
  });

  it("lets the other parts lean back by varying amounts", () => {
    const late = t.notes.filter((n) => n.instrument === "perc" || n.pitch === 42).map(offset);
    expect(Math.min(...late)).toBeGreaterThanOrEqual(0);
    expect(new Set(late.map((v) => Math.round(v * 10000))).size).toBeGreaterThan(20);
    expect(Math.max(...late)).toBeLessThan(0.05);
  });

  it("turns percussion loops against the bar", () => {
    for (const style of STYLES) {
      const track = gen({ style });
      const s = track.sections.find((x) => x.kind === "groove")!;
      const bar = (b: number) => lane(track, "perc").filter((n) => Math.floor(n.step / 16) === s.startBar + b).map((n) => `${n.step % 16}:${n.pitch}`).sort().join();
      expect(new Set([0, 1, 2, 3].map(bar)).size).toBeGreaterThan(1);
    }
  });

  it("keeps the bass off every kick", () => {
    for (const style of STYLES.filter((s) => s !== "acid")) {
      for (const n of lane(gen({ style }), "bass")) expect(n.step % 4).not.toBe(0);
    }
  });

  it("starts each mix move where the last one ended", () => {
    for (const bars of LENGTHS) {
      const track = gen({ bars });
      for (const param of ["cutoff", "space", "echo"]) {
        const moves = track.automation.filter((a) => a.param === param);
        for (let i = 1; i < moves.length; i++) {
          expect(moves[i].from).toBe(moves[i - 1].value);
          expect(moves[i].time).toBeGreaterThanOrEqual(moves[i - 1].time + moves[i - 1].ramp - 1e-6);
        }
      }
    }
  });
});

describe("edits and dead controls", () => {
  it("a deleted bass note stays deleted in another key", () => {
    const n = lane(gen(), "bass")[0];
    const edits = [{ op: "remove" as const, lane: "bass" as Lane, step: n.step, pitch: n.pitch, root: base.rootPitch }];
    for (let rootPitch = 0; rootPitch < 12; rootPitch++) {
      const t = generativeEngine.generate({ ...base, rootPitch }, edits);
      expect(lane(t, "bass").some((x) => x.step === n.step)).toBe(false);
    }
  });

  it("an added note follows the key, and a deletion doesn't take it", () => {
    const n = lane(gen(), "bass")[0];
    const edits = [
      { op: "remove" as const, lane: "bass" as Lane, step: n.step, pitch: n.pitch, root: 9 },
      { op: "add" as const, lane: "bass" as Lane, step: n.step, pitch: 33, root: 9 },
    ];
    const t = generativeEngine.generate({ ...base, rootPitch: 7 }, edits);
    expect(lane(t, "bass").filter((x) => x.step === n.step).map((x) => x.pitch)).toEqual([31]);
  });

  it("minor differs from auto when auto would pick another scale", () => {
    expect(gen({ valence: 0.1, mode: "minor" }).scale).not.toEqual(gen({ valence: 0.1 }).scale);
  });

  it("rewriting Chord or Atmos never gives the same part", () => {
    const part = (t: ReturnType<typeof gen>, l: string) => lane(t, l).map((n) => `${n.step}:${n.variant}`).join();
    for (const style of ["hypnotic", "tribal", "dub", "warehouse"] as const) {
      for (let seed = 1; seed < 20; seed++) {
        for (const l of ["stab", "pad"] as Lane[]) {
          expect(part(gen({ style, seed }), l)).not.toBe(part(gen({ style, seed, laneSeeds: { [l]: 1 } }), l));
        }
      }
    }
  });
});

describe("hostile input", () => {
  it("ignores held notes the model doesn't have", () => {
    for (const token of [999, -1, 1.5, NaN, neuralRiff.vocab.length]) {
      expect(() => gen({ pins: { 0: token } })).not.toThrow();
    }
  });

  it("drops edits past the end of the track", () => {
    const t = generativeEngine.generate({ ...base, bars: 16 }, [{ op: "add", lane: "bass", step: 900, pitch: 33 }]);
    expect(t.notes.some((n) => n.step === 900)).toBe(false);
  });
});
