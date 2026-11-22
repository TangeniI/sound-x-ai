import { describe, it, expect } from "vitest";
import { cleanControls, encodeConfig, parseConfigFromURL } from "./share";
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

  it("rejects held notes and edits that can't exist", () => {
    expect(parseConfigFromURL("p=0:999.1:-1.40:3").config.pins).toEqual({});
    expect(parseConfigFromURL("n=ab999999:40").edits).toEqual([]);
    expect(parseConfigFromURL(`n=${Array(5000).fill("ab4:40").join(".")}`).edits).toHaveLength(1000);
  });

  it("carries a Groove family and the key an edit was made in", () => {
    const groove: GeneratorConfig = { ...cfg, style: "driving", family: "concrete" };
    const keyed: NoteEdit[] = [{ op: "add", lane: "bass", step: 18, pitch: 31, root: 7 }];
    const back = parseConfigFromURL(encodeConfig(groove, keyed));
    expect(back.config).toEqual(groove);
    expect(back.edits).toEqual(keyed);
    expect(parseConfigFromURL("f=constructor").config.family).toBeUndefined();
  });

  it("opens links from before the rebuild", () => {
    expect(parseConfigFromURL("s=melodic").config.style).toBe("tribal");
    expect(parseConfigFromURL("s=constructor").config.style).toBeUndefined();
  });

  it("keeps only usable saved settings", () => {
    expect(cleanControls({ style: "nope", rootPitch: null, tempo: 0, energy: 2, mode: "x" })).toEqual({});
    expect(cleanControls(null)).toEqual({});
    expect(cleanControls({ style: "dub", tempo: 140, extra: 1 })).toEqual({ style: "dub", tempo: 140 });
  });
});
