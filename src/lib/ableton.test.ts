import { describe, expect, it } from "vitest";
import { gzip, liveSetXml, type AlsSet } from "./ableton";

const set: AlsSet = {
  bpm: 138,
  beats: 128,
  locators: [{ time: 0, name: "Intro" }, { time: 64, name: "Peak & <drop>" }],
  audio: [
    { name: "kick", file: "Samples/Imported/01-kick.wav", frames: 48000 * 60, sampleRate: 48000, warp: "beats", color: 14 },
    { name: "music", file: "Samples/Imported/02-music.wav", frames: 44100 * 60, sampleRate: 44100, warp: "tones", color: 3 },
  ],
  midi: [{
    name: "Bass MIDI", color: 1,
    notes: [{ pitch: 36, time: 0, duration: 0.25, velocity: 100 }, { pitch: 36, time: 1, duration: 0.25, velocity: 0 }, { pitch: 43, time: 0.5, duration: 0.5, velocity: 300 }],
  }],
};

/** A small reader for the XML Live sets use: elements and attributes, no text. Throws if it isn't well-formed. */
interface Node { tag: string; attrs: Record<string, string>; children: Node[] }
function parse(xml: string): Node {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const root: Node = { tag: "#document", attrs: {}, children: [] };
  const stack = [root];
  const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const re = /<(\/?)([A-Za-z][\w.]*)((?:\s+[\w.]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(body))) {
    if (m.index !== at) throw new Error(`stray text at ${at}`);
    at = re.lastIndex;
    if (m[5] !== undefined) { if (m[5].trim()) throw new Error(`text at ${m.index}`); continue; }
    const [, close, tag, rawAttrs, self] = m;
    if (close) {
      if (stack.pop()!.tag !== tag) throw new Error(`mismatched </${tag}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([\w.]+)="([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  if (at !== body.length || stack.length !== 1) throw new Error("unclosed element");
  return root.children[0];
}
/** Elements at a path of tag names below a node, e.g. "Tracks/AudioTrack". */
const all = (n: Node, path: string): Node[] =>
  path.split("/").reduce<Node[]>((nodes, tag) => nodes.flatMap((x) => x.children.filter((c) => c.tag === tag)), [n]);
const one = (n: Node, path: string): Node => {
  const found = all(n, path);
  if (!found.length) throw new Error(`no ${path}`);
  return found[0];
};
const val = (n: Node, path: string) => one(n, path).attrs.Value;

describe("Ableton Live set", () => {
  const root = parse(liveSetXml(set));
  const live = one(root, "LiveSet");

  it("is well-formed XML Live 12 reads", () => {
    expect(root.tag).toBe("Ableton");
    expect(root.attrs.MinorVersion).toMatch(/^12\./);
  });

  it("sets the tempo and marks the sections", () => {
    expect(val(live, "MainTrack/DeviceChain/Mixer/Tempo/Manual")).toBe("138");
    const locators = all(live, "Locators/Locators/Locator");
    expect(locators.map((l) => val(l, "Time"))).toEqual(["0", "64"]);
    expect(val(locators[1], "Name")).toBe("Peak & <drop>");
  });

  it("gives every track a slot for every scene, which Live needs to stay up", () => {
    const scenes = all(live, "Scenes/Scene").length;
    expect(scenes).toBeGreaterThan(0);
    const tracks = [...all(live, "Tracks/AudioTrack"), ...all(live, "Tracks/MidiTrack")];
    expect(tracks).toHaveLength(set.audio.length + set.midi.length);
    for (const t of tracks) {
      for (const seq of ["MainSequencer", "FreezeSequencer"]) expect(all(t, `DeviceChain/${seq}/ClipSlotList/ClipSlot`)).toHaveLength(scenes);
    }
  });

  it("puts each stem on the arrangement, warped to the set's tempo", () => {
    const tracks = all(live, "Tracks/AudioTrack");
    expect(tracks.map((t) => val(t, "Name/EffectiveName"))).toEqual(["kick", "music"]);
    const clip = one(tracks[1], "DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip");
    expect(val(clip, "SampleRef/FileRef/RelativePath")).toBe("Samples/Imported/02-music.wav");
    expect(val(clip, "SampleRef/DefaultSampleRate")).toBe("44100");
    expect(val(clip, "WarpMode")).toBe("1");
    // a minute at 138 BPM is 138 beats
    expect(all(clip, "WarpMarkers/WarpMarker").map((m) => [m.attrs.SecTime, m.attrs.BeatTime])).toEqual([["0", "0"], ["60", "138"]]);
    expect(val(clip, "CurrentEnd")).toBe("138");
    expect(val(clip, "Loop/LoopOn")).toBe("false");
  });

  it("writes the parts as MIDI clips, one key track per pitch", () => {
    const track = one(live, "Tracks/MidiTrack");
    expect(val(track, "Name/EffectiveName")).toBe("Bass MIDI");
    const clip = one(track, "DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip");
    expect(val(clip, "CurrentEnd")).toBe("128");
    const keys = all(clip, "Notes/KeyTracks/KeyTrack");
    expect(keys.map((k) => val(k, "MidiKey"))).toEqual(["36", "43"]);
    const notes = keys.flatMap((k) => all(k, "Notes/MidiNoteEvent"));
    expect(notes).toHaveLength(3);
    // velocities stay in Live's 1–127, and note ids are unique
    expect(notes.map((n) => Number(n.attrs.Velocity))).toEqual([100, 1, 127]);
    expect(new Set(notes.map((n) => n.attrs.NoteId)).size).toBe(3);
    expect(val(clip, "Notes/NoteIdGenerator/NextId")).toBe("4");
  });

  it("plays a whole track through, and a loop round and round", () => {
    expect(val(live, "Transport/LoopOn")).toBe("false");
    const loop = one(parse(liveSetXml({ ...set, beats: 32, loop: true })), "LiveSet");
    expect([val(loop, "Transport/LoopOn"), val(loop, "Transport/LoopStart"), val(loop, "Transport/LoopLength")]).toEqual(["true", "0", "32"]);
    const clips = [
      ...all(loop, "Tracks/AudioTrack/DeviceChain/MainSequencer/Sample/ArrangerAutomation/Events/AudioClip"),
      ...all(loop, "Tracks/MidiTrack/DeviceChain/MainSequencer/ClipTimeable/ArrangerAutomation/Events/MidiClip"),
    ];
    expect(clips).toHaveLength(3);
    for (const c of clips) expect(val(c, "Loop/LoopOn")).toBe("true");
  });

  it("gives every track its own id", () => {
    const ids = one(live, "Tracks").children.map((t) => t.attrs.Id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gzips the set as Live expects", async () => {
    const xml = liveSetXml(set);
    const packed = await gzip(xml);
    expect([packed[0], packed[1]]).toEqual([0x1f, 0x8b]);
    const back = await new Response(new Blob([packed as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(back).toBe(xml);
  });
});
