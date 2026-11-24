import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, generativeEngine, LENGTHS } from "../generative-engine";
import type { GeneratorConfig, Lane, NoteEvent, Track } from "../../types";
import { FAMILIES, HATS, type Family } from "./families";
import { loopBars, placeOf, pullsFor } from "./flow";
import { chooseParts, strip, weaknesses } from "./parts";

const config = (over: Partial<GeneratorConfig> = {}): GeneratorConfig => ({ ...DEFAULT_CONFIG, style: "driving", bars: 64, ...over });
const gen = (over: Partial<GeneratorConfig> = {}) => generativeEngine.generate(config(over));
const idea = (t: Track, f: Family) => t.notes.filter((n) => n.instrument === f.idea.lane && n.variant == null);
const between = (notes: NoteEvent[], from: number, to: number) => notes.filter((n) => n.step >= from && n.step < to);
const isKick = (n: NoteEvent) => n.instrument === "drums" && (n.pitch === 36 || n.pitch === 35);
const peak = (t: Track) => {
  const { start, end } = loopBars(t.sections);
  return between(t.notes, start * 16, end * 16).map((n) => ({ ...n, step: n.step - start * 16 }));
};

describe("families", () => {
  it("has twelve, each with its own name and idea", () => {
    expect(FAMILIES).toHaveLength(12);
    expect(new Set(FAMILIES.map((f) => f.name)).size).toBe(12);
    expect(new Set(FAMILIES.map((f) => f.idea.lines.join())).size).toBe(12);
  });

  it("every pattern is whole bars of known symbols", () => {
    for (const f of FAMILIES) {
      for (const line of [...f.idea.lines, ...f.claps, ...f.bass, ...f.hats.flatMap((h) => [HATS[h].closed, HATS[h].open])]) {
        expect([16, 32]).toContain(strip(line).length);
        expect(strip(line)).toMatch(/^[xo.htu-]+$/);
      }
      for (const fill of f.fills) expect(fill).toHaveLength(4);
    }
  });

  it("keeps each family's keys where the sub has weight", () => {
    for (const f of FAMILIES) for (const key of f.keys) expect(key >= 4 && key <= 11).toBe(true);
  });

  it("finds every family from a seed alone", () => {
    const found = new Set(Array.from({ length: 300 }, (_, i) => gen({ seed: i + 1 }).family!.id));
    expect(found.size).toBe(12);
  });
});

for (const f of FAMILIES) {
  describe(f.name, () => {
    const over = { family: f.id, rootPitch: f.keys[0], tempo: f.tempo[0] };

    it("turns down weak takes", () => {
      for (let seed = 1; seed <= 150; seed++) {
        const p = chooseParts(config({ ...over, seed }));
        expect(weaknesses(f, { ...p, hats: "" }, p.room)).toEqual([]);
      }
    });

    it("has its idea from the first two bars and all through the peak", () => {
      for (const bars of LENGTHS) {
        const t = gen({ ...over, bars });
        const { start } = loopBars(t.sections);
        expect(idea(t, f).some((n) => n.step < 32)).toBe(true);
        for (let bar = start; bar < start + 6; bar += 2) expect(between(idea(t, f), bar * 16, bar * 16 + 32).length).toBeGreaterThanOrEqual(4);
      }
    });

    it("empties the floor before each hit and lands on the one", () => {
      for (const bars of LENGTHS) {
        for (let seed = 1; seed <= 6; seed++) {
          const cfg = config({ ...over, bars, seed });
          const t = generativeEngine.generate(cfg);
          const low = t.automation.filter((a) => a.param === "low");
          for (const p of pullsFor(cfg, f, t.sections, bars)) {
            expect(p.to - p.gone).toBeGreaterThanOrEqual(4);
            const gone = between(t.notes, p.gone, p.to);
            expect(gone.filter(isKick)).toEqual([]);
            expect(gone.filter((n) => n.instrument === "bass")).toEqual([]);
            expect(low.some((a) => a.value === 0 && Math.abs(a.time - p.gone * t.stepSec) < 1e-6)).toBe(true);
            if (p.to === bars * 16) continue;
            const back = t.notes.find((n) => n.step === p.to && n.instrument === "drums" && n.pitch === 36)!;
            expect(back.startTime).toBeCloseTo(p.to * t.stepSec, 9);
            expect(low.some((a) => a.value === 1 && Math.abs(a.time - back.startTime) < 1e-6)).toBe(true);
          }
        }
      }
    });

    it("has a beginning, a middle and an end", () => {
      const overlap: number[] = [];
      for (const bars of LENGTHS.filter((b) => b >= 32)) {
        for (let seed = 1; seed <= 8; seed++) {
          const t = gen({ ...over, bars, seed });
          const acts = Array.from({ length: bars }, (_, bar) => placeOf(t.sections, bar).act);
          expect(acts.filter((act, i) => act !== acts[i - 1])).toEqual(["beginning", "middle", "end", "outro"]);
          const first = loopBars(t.sections).start;
          // the last full phrase before each turn of the story
          const brk = t.sections.find((s) => s.kind === "break")!.startBar;
          const phrases = [0, brk - 4, first + 4].map((bar) => new Set(between(t.notes, bar * 16, bar * 16 + 64)
            .filter((n) => n.instrument !== "fx" && !isKick(n)).map((n) => `${n.instrument}:${n.pitch}:${n.step - bar * 16}`)));
          for (const [a, b] of [[0, 1], [1, 2], [0, 2]]) {
            const both = [...phrases[a]].filter((h) => phrases[b].has(h)).length;
            overlap.push(both / (phrases[a].size + phrases[b].size - both));
          }
          expect(t.endKit!.from).toBe(first * 16);
          expect(t.endKit!.kit).not.toEqual(t.kit);
        }
      }
      expect(overlap.sort((a, b) => a - b)[overlap.length >> 1]).toBeLessThan(0.75);
    });

    it("holds the first bar of its idea while the answer changes", () => {
      for (let seed = 1; seed <= 40; seed++) {
        const { idea: line, later } = chooseParts(config({ ...over, seed }));
        for (const answer of later.answers) {
          expect(answer.slice(0, 16)).toBe(line.slice(0, 16));
          expect(answer).not.toBe(line);
        }
      }
    });

    it("loops eight bars that end in a wind-down and start on the hit", () => {
      for (const bars of LENGTHS) {
        const t = gen({ ...over, bars });
        const notes = peak(t);
        expect(loopBars(t.sections).end - loopBars(t.sections).start).toBe(8);
        expect(notes.some((n) => n.step === 0 && n.pitch === 36)).toBe(true);
        expect(between(notes, 124, 128).filter(isKick)).toEqual([]);
      }
    });

    it("a rewrite changes that part and only that part", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const a = gen({ ...over, seed });
        const part = (t: Track, l: string) => t.notes.filter((n) => n.instrument === l).map((n) => `${n.step}:${n.pitch}:${n.variant}:${n.velocity > 90}`).join();
        const lanes = (["drums", "perc", "bass", "stab", "lead", "pad"] as Lane[]).filter((l) => part(a, l));
        for (const l of lanes) {
          const b = gen({ ...over, seed, laneSeeds: { [l]: 1 } });
          expect(part(b, l)).not.toBe(part(a, l));
          for (const other of lanes) if (other !== l) expect(part(b, other)).toBe(part(a, other));
        }
      }
    });

    it("stays in key in all twelve keys", () => {
      for (let rootPitch = 0; rootPitch < 12; rootPitch++) {
        for (const valence of [0.1, 0.5, 0.8]) {
          const t = gen({ ...over, rootPitch, valence });
          for (const n of t.notes.filter((x) => ["bass", "lead", "stab"].includes(x.instrument))) {
            for (const off of n.chord ?? [0]) expect([0, 7]).toContain((n.pitch + off - rootPitch + 120) % 12);
          }
        }
      }
    });

    it("plays dead on the grid, like the references", () => {
      const t = gen(over);
      for (const n of t.notes.filter((x) => x.pitch === 36 && x.instrument === "drums")) expect(n.startTime).toBeCloseTo(n.step * t.stepSec, 9);
      // no swing and no lean: every hit within 2 ms of its step
      for (const n of t.notes.filter((x) => x.instrument === "drums" || x.instrument === "perc")) {
        expect(Math.abs(n.startTime - n.step * t.stepSec)).toBeLessThan(0.002);
      }
    });
  });
}

describe("distinctness", () => {
  it("two families share well under half their hits, kick aside", () => {
    const hits = (t: Track) => new Set(peak(t).filter((n) => n.instrument !== "fx" && !isKick(n)).map((n) => `${n.instrument}:${n.pitch}:${n.step}`));
    const sets = FAMILIES.map((f) => hits(gen({ family: f.id })));
    const shared: number[] = [];
    sets.forEach((a, i) => sets.slice(i + 1).forEach((b) => {
      const both = [...a].filter((h) => b.has(h)).length;
      shared.push(both / (a.size + b.size - both));
    }));
    expect(shared.sort((a, b) => a - b)[shared.length >> 1]).toBeLessThan(0.4);
  });
});
