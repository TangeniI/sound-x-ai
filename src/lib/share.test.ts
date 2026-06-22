import { describe, it, expect } from "vitest";
import { encodeConfig, parseConfigFromURL } from "./share";
import type { GeneratorConfig } from "../types";

const cfg: GeneratorConfig = {
  style: "acid", bars: 12, tempo: 140, energy: 0.8, valence: 0.3,
  density: 0.7, variation: 0.5, rootPitch: 5, seedFromAudio: false,
};

describe("share links", () => {
  it("round-trips a config through the URL", () => {
    const parsed = parseConfigFromURL(encodeConfig(cfg));
    expect(parsed.style).toBe("acid");
    expect(parsed.bars).toBe(12);
    expect(parsed.tempo).toBe(140);
    expect(parsed.rootPitch).toBe(5);
    expect(parsed.energy).toBeCloseTo(0.8, 2);
    expect(parsed.valence).toBeCloseTo(0.3, 2);
    expect(parsed.density).toBeCloseTo(0.7, 2);
    expect(parsed.variation).toBeCloseTo(0.5, 2);
  });

  it("ignores an invalid style and clamps out-of-range values", () => {
    const parsed = parseConfigFromURL("s=notastyle&t=9999&k=99&e=5");
    expect(parsed.style).toBeUndefined();
    expect(parsed.tempo).toBe(175); // clamped to max
    expect(parsed.rootPitch).toBe(11); // clamped to max
    expect(parsed.energy).toBe(1); // clamped to [0,1]
  });

  it("returns an empty object for an empty query", () => {
    expect(parseConfigFromURL("")).toEqual({});
  });
});
