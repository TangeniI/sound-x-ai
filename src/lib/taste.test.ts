import { describe, expect, it } from "vitest";
import { FAMILIES, FAMILY_IDS } from "./groove/families";
import { drawRoot, drawSetting, emptyTaste, evaluate, learn, outcomeOf, pickFamily, predict, type Outcome, type TasteEvent } from "./taste";
import type { FamilyId } from "../types";

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A take as Randomise would make it, with no taste learned. */
function randomTake(rnd: () => number, at: number) {
  const f = FAMILIES[Math.floor(rnd() * FAMILIES.length)];
  return {
    at, heard: 30,
    family: f.id,
    tempo: f.tempo[0] + Math.round(rnd() * (f.tempo[1] - f.tempo[0])),
    root: f.keys[Math.floor(rnd() * f.keys.length)],
    energy: 0.62 + rnd() * 0.23, valence: 0.12 + rnd() * 0.33, density: 0.5 + rnd() * 0.3, variation: 0.25 + rnd() * 0.3,
  };
}

/** Someone who keeps Night Shift and Undertow when they're dense, and skips most else. */
function synthetic(n: number, seed: number): TasteEvent[] {
  const rnd = seeded(seed);
  return Array.from({ length: n }, (_, i) => {
    const t = randomTake(rnd, i * 60_000);
    const liked = t.family === "night" || t.family === "undertow";
    const p = liked ? (t.density > 0.65 ? 0.85 : 0.25) : 0.1;
    const outcome: Outcome = rnd() < p ? (rnd() < 0.4 ? "export" : "keep") : "skip";
    return { ...t, outcome };
  });
}

const share = (picks: FamilyId[], ids: FamilyId[]) => picks.filter((p) => ids.includes(p)).length / picks.length;

describe("taste: what leaving a take says", () => {
  it("counts exports, work and long listens as keeps, and ignores takes nobody heard", () => {
    expect(outcomeOf({ heard: 2, touched: false, exported: true })).toBe("export");
    expect(outcomeOf({ heard: 2, touched: true, exported: false })).toBe("keep");
    expect(outcomeOf({ heard: 50, touched: false, exported: false })).toBe("keep");
    expect(outcomeOf({ heard: 12, touched: false, exported: false })).toBe("skip");
    expect(outcomeOf({ heard: 1, touched: false, exported: false })).toBeNull();
  });
});

describe("taste: steering Randomise", () => {
  it("picks every family about equally before it has learned anything", () => {
    const rnd = seeded(1);
    const picks = Array.from({ length: 6000 }, () => pickFamily(emptyTaste(), FAMILY_IDS, rnd));
    for (const id of FAMILY_IDS) {
      const s = share(picks, [id]);
      expect(s).toBeGreaterThan(1 / FAMILY_IDS.length - 0.025);
      expect(s).toBeLessThan(1 / FAMILY_IDS.length + 0.025);
    }
  });

  it("leans to the families kept, and still tries the others", () => {
    const taste = learn(synthetic(200, 2));
    const rnd = seeded(3);
    const picks = Array.from({ length: 4000 }, () => pickFamily(taste, FAMILY_IDS, rnd));
    const liked = share(picks, ["night", "undertow"]);
    expect(liked).toBeGreaterThan(0.45); // two of twelve would be 0.17
    expect(liked).toBeLessThan(0.97);
  });

  it("draws settings inside their range, nearer to what was kept", () => {
    const taste = learn(synthetic(400, 4));
    const rnd = seeded(5);
    const draws = Array.from({ length: 3000 }, () => drawSetting(taste, "night", "density", 0.5, 0.8, rnd));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...draws)).toBeLessThanOrEqual(0.8);
    expect(draws.reduce((a, b) => a + b, 0) / draws.length).toBeGreaterThan(0.665); // uniform would be 0.65
    // a family with nothing kept is drawn evenly
    const flat = Array.from({ length: 3000 }, () => drawSetting(emptyTaste(), "night", "density", 0.5, 0.8, rnd));
    expect(Math.abs(flat.reduce((a, b) => a + b, 0) / flat.length - 0.65)).toBeLessThan(0.01);
  });

  it("only ever picks a root from the family's own keys", () => {
    const taste = learn(synthetic(200, 6));
    const rnd = seeded(7);
    for (const f of FAMILIES) {
      for (let i = 0; i < 50; i++) expect(f.keys).toContain(drawRoot(taste, f.id, f.keys, rnd));
    }
  });

  it("estimates a liked family's take as more likely kept", () => {
    const taste = learn(synthetic(300, 8));
    const take = randomTake(seeded(9), 0);
    expect(predict(taste, { ...take, family: "night", density: 0.78 })).toBeGreaterThan(predict(taste, { ...take, family: "signal" }));
  });
});

describe("taste: held-out evaluation", () => {
  it("beats the baseline on later takes when there is a taste to learn", () => {
    const r = evaluate(synthetic(300, 10));
    expect(r.enough).toBe(true);
    expect([r.train, r.test]).toEqual([210, 90]);
    expect(r.model).toBeLessThan(r.baseline);
    expect(r.auc).toBeGreaterThan(0.65); // a tenth of the other takes are kept at random, so it can't be near 1
  });

  it("doesn't find a taste in coin flips", () => {
    const rnd = seeded(11);
    const events = Array.from({ length: 300 }, (_, i) => ({ ...randomTake(rnd, i), outcome: (rnd() < 0.5 ? "keep" : "skip") as Outcome }));
    const r = evaluate(events);
    expect(r.auc).toBeGreaterThan(0.35);
    expect(r.auc).toBeLessThan(0.65);
    expect(r.model).toBeGreaterThan(r.baseline - 0.03);
  });

  it("scores only takes made after the ones it learned from", () => {
    const events = synthetic(100, 12).reverse(); // out of order on purpose
    const r = evaluate(events);
    expect(r.train + r.test).toBe(100);
    expect(r.enough).toBe(true);
  });

  it("says when there's too little to tell", () => {
    expect(evaluate(synthetic(20, 13)).enough).toBe(false);
  });
});
