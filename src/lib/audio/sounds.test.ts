import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SOUND_SLOTS } from "../../types";
import { DEFAULT_CONFIG, generativeEngine } from "../generative-engine";
import { FAMILIES } from "../groove/families";
import { encodeConfig, parseConfigFromURL } from "../share";
import { CHORDS, chordOf, DEFAULT_CHORD, kitSamples, ownKickRoots, SOUND_CHOICES, withSounds } from "./kits";
import { measureKickRoot } from "./own-samples";

const file = (id: string) => resolve(__dirname, "../../../public/samples", `${id}.flac`);

describe("sound swaps", () => {
  it("only offer recordings that ship", () => {
    for (const slot of SOUND_SLOTS) {
      for (const c of SOUND_CHOICES[slot]) {
        // a chord choice is an instrument, three recorded notes
        const ids = slot === "chord" ? CHORDS[c.id].zones.map((z) => z.id) : [c.id];
        for (const id of ids) expect(existsSync(file(id)), id).toBe(true);
      }
    }
    for (const f of FAMILIES) for (const kit of [f.kit, ...f.alts.map((a) => ({ ...f.kit, ...a }))]) {
      for (const id of kitSamples(kit)) expect(existsSync(file(id)), `${f.id}: ${id}`).toBe(true);
    }
  });

  it("change only the sounds asked for, and keep a swapped kick in key", () => {
    const kit = FAMILIES[0].kit;
    const out = withSounds(kit, { kick: "kick_tek", snare: "snare_808", hat: "shaker" });
    expect(out.kick).toBe("kick_tek");
    expect(out.kickRoot).toBe(40.3);
    expect(out.snare).toEqual([{ id: "snare_808", gain: 0.95 }]);
    expect(out.hatC).toEqual(["shaker", kit.hatC[1]]);
    expect(out.clap).toEqual(kit.clap);
    expect(withSounds(kit)).toEqual(kit);
    ownKickRoots.set("user:00000000000000aa", 36.2);
    expect(withSounds(kit, { kick: "user:00000000000000aa" }).kickRoot).toBe(36.2);
    ownKickRoots.delete("user:00000000000000aa");
  });

  it("play chords on a real instrument, never the FM synth", () => {
    for (const f of FAMILIES) {
      const ids = kitSamples(f.kit);
      expect(ids.some((id) => id.startsWith("fm_") && !f.kit.lead.zones.some((z) => z.id === id)), f.id).toBe(false);
      expect(ids).toContain("grand_c4");
    }
    expect(chordOf(withSounds(FAMILIES[0].kit, { chord: "chord_organ" }))).toBe(CHORDS.chord_organ);
    expect(chordOf(withSounds(FAMILIES[0].kit, { chord: "nope" }))).toBe(CHORDS[DEFAULT_CHORD]);
    // between its lowest and highest recording, no note is stretched more than a tritone
    for (const c of Object.values(CHORDS)) {
      const roots = c.zones.map((z) => z.root);
      for (let p = roots[0]; p <= roots[roots.length - 1]; p++) {
        expect(Math.min(...roots.map((r) => Math.abs(r - p)))).toBeLessThanOrEqual(7);
      }
    }
    expect(parseConfigFromURL(encodeConfig({ ...DEFAULT_CONFIG, sounds: { chord: "chord_vibes" } })).config.sounds).toEqual({ chord: "chord_vibes" });
  });

  it("hold through the whole track, the change at the drop included", () => {
    const t = generativeEngine.generate({ ...DEFAULT_CONFIG, sounds: { kick: "kick_klub", clap: "clap_hands" } });
    for (const kit of [t.kit, t.endKit!.kit]) {
      expect(kit.kick).toBe("kick_klub");
      expect(kit.clap[0]).toBe("clap_hands");
    }
    const plain = generativeEngine.generate(DEFAULT_CONFIG);
    expect(t.notes).toEqual(plain.notes); // a swap changes the sound, never the notes
  });

  it("travel in links, except the producer's own", () => {
    const cfg = { ...DEFAULT_CONFIG, sounds: { kick: "kick_tek", snare: "user:0123456789abcdef", perc2: "anvil" } };
    expect(parseConfigFromURL(encodeConfig(cfg)).config.sounds).toEqual(cfg.sounds);
    expect(parseConfigFromURL(encodeConfig(cfg, [], { own: false })).config.sounds).toEqual({ kick: "kick_tek", perc2: "anvil" });
    // a link can't name a file that isn't in the pack, or put one in the wrong place
    expect(parseConfigFromURL("o=k../../x.hat_909_c").config.sounds).toEqual({});
    expect(parseConfigFromURL("o=kanvil").config.sounds).toEqual({});
  });
});

describe("own kicks", () => {
  it("are measured at the pitch of their body", () => {
    const sr = 44100;
    const data = new Float32Array(sr * 0.4);
    const hz = 55; // A1, MIDI 33
    for (let i = 0; i < data.length; i++) {
      const t = i / sr;
      data[i] = Math.sin(2 * Math.PI * hz * t) * Math.exp(-t * 6) + (i < 200 ? Math.random() * 0.5 : 0);
    }
    expect(measureKickRoot(data, sr)).toBeCloseTo(33, 0);
    expect(measureKickRoot(new Float32Array(1000), sr)).toBeUndefined();
  });
});
