import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StyleId } from "../../types";
import { ceilingCurve, softClip, undoMakeup } from "./graph";
import { FAMILIES } from "../groove/families";
import { kitSamples, KITS, SUB } from "./kits";

const styles = Object.keys(KITS) as StyleId[];
// every kit that can play: five styles, and both sets of sounds for each Groove family
const kits = [...styles.map((s) => KITS[s]), ...FAMILIES.flatMap((f) => f.alts.map((alt) => ({ ...f.kit, ...alt })))];
const shipped = new Set(readdirSync("public/samples").map((f) => f.replace(".flac", "")));

describe("kits", () => {
  it("only asks for recordings that ship", () => {
    for (const kit of kits) {
      for (const id of kitSamples(kit)) expect(shipped).toContain(id);
    }
  });

  it("builds the low end from drums, with no bass preset or chord recording", () => {
    for (const kit of kits) {
      for (const id of kitSamples(kit)) expect(id).not.toMatch(/^(bass|chord|pad|drone)/);
    }
    expect(SUB.id).toMatch(/^kick_/);
  });
});

describe("saturation", () => {
  // a hard clip is a kink: the slope is still steep where the curve runs out
  const endSlope = (c: Float32Array) => (c[c.length - 1] - c[c.length - 2]) / (8 / (c.length - 1));

  it("is flat where each curve ends, so overs bend instead of clipping", () => {
    for (const k of [0.9, 1.3, 1.4, 1.9, 2.6, 4]) expect(endSlope(softClip(k))).toBeLessThan(0.02);
    expect(endSlope(ceilingCurve())).toBeLessThan(0.02);
  });

  it("the master ceiling never passes full scale and leaves quiet signal alone", () => {
    const c = ceilingCurve();
    expect(Math.max(...c)).toBeLessThanOrEqual(1);
    const at = (x: number) => c[Math.round(((x / 4 + 1) / 2) * (c.length - 1))];
    expect(at(0.25)).toBeCloseTo(0.25, 2);
  });

  it("undoes the compressor's automatic makeup gain", () => {
    expect(20 * Math.log10(undoMakeup(-10, 1.6))).toBeCloseTo(-2.25, 2);
  });
});
