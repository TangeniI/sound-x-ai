import { describe, it, expect } from "vitest";
import { encodeConfig, parseConfigFromURL } from "./share";
import { DEFAULT_CONFIG } from "./generative-engine";
import type { GeneratorConfig, NoteEdit } from "../types";

const cfg: GeneratorConfig = {
  ...DEFAULT_CONFIG, style: "dub", bars: 64, tempo: 133, energy: 0.71, valence: 0.33, density: 0.62,
  variation: 0.4, rootPitch: 4, mode: "minor", seed: 123456, laneSeeds: { bass: 3, lead: 9 }, pins: { 4: 12, 18: 3 },
};
const edits: NoteEdit[] = [
  { op: "add", lane: "bass", step: 42, pitch: 40 },
  { op: "remove", lane: "drums", step: 16, pitch: 42 },
];

describe("share links", () => {
  it("carries a whole track: seed, lanes, held notes and edits", () => {
    const { config, edits: back } = parseConfigFromURL(encodeConfig(cfg, edits));
    expect(config).toEqual(cfg);
    expect(back).toEqual(edits);
  });

  it("clamps out-of-range values and ignores junk", () => {
    const { config, edits: back } = parseConfigFromURL("s=polka&t=9999&e=5&k=99&n=zz.a?1:2");
    expect(config.style).toBeUndefined();
    expect(config.tempo).toBe(175);
    expect(config.energy).toBe(1);
    expect(config.rootPitch).toBe(11);
    expect(back).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(parseConfigFromURL("")).toEqual({ config: {}, edits: [] });
  });
});
