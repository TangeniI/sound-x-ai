/**
 * lib/ableton.ts
 *
 * An Ableton Live set (.als) for a take: the stems on audio tracks, warped so
 * they follow the set's tempo, the parts as MIDI clips to put instruments on,
 * and a locator at each section. Opens in Live 12, Intro included.
 *
 * A .als is gzipped XML. Live fills in anything a set leaves out with its own
 * defaults, so this writes only what the take decides: the tempo, the tracks,
 * the clips and the locators. Every element used here is one Live writes itself.
 * Samples are found relative to the set, so the zip unpacks to a folder that
 * opens as it is.
 */

export interface AlsAudioTrack {
  name: string;
  /** Path of the audio file from the folder the set is in, with forward slashes. */
  file: string;
  frames: number;
  sampleRate: number;
  /** Live's warp modes in every edition: Beats for drums, Tones for anything with pitch. */
  warp: "beats" | "tones";
  color: number;
}

export interface AlsNote {
  pitch: number;
  /** In beats from the start of the set. */
  time: number;
  duration: number;
  velocity: number;
}

export interface AlsMidiTrack {
  name: string;
  notes: AlsNote[];
  color: number;
}

export interface AlsSet {
  bpm: number;
  /** Length of the arrangement, in beats. */
  beats: number;
  locators: { time: number; name: string }[];
  /** A loop: clips repeat when drawn out, and the set loops the whole length. */
  loop?: boolean;
  audio: AlsAudioTrack[];
  midi: AlsMidiTrack[];
}

const WARP_MODE = { beats: 0, tones: 1 } as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Numbers as Live writes them: plain decimals, no exponent. */
const num = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};
const v = (tag: string, value: string | number | boolean) => `<${tag} Value="${typeof value === "string" ? esc(value) : typeof value === "number" ? num(value) : value}" />`;

function name(n: string): string {
  return `<Name>${v("EffectiveName", n)}${v("UserName", n)}${v("Annotation", "")}${v("MemorizedFirstClipName", "")}</Name>`;
}

/** The parts every clip shares: where it sits, how long it is, and whether it repeats. */
function clipHead(start: number, end: number, label: string, color: number, loop: boolean): string {
  return [
    v("LomId", 0), v("LomIdView", 0), v("CurrentStart", start), v("CurrentEnd", end),
    `<Loop>${v("LoopStart", 0)}${v("LoopEnd", end - start)}${v("StartRelative", 0)}${v("LoopOn", loop)}${v("OutMarker", end - start)}${v("HiddenLoopStart", 0)}${v("HiddenLoopEnd", end - start)}</Loop>`,
    v("Name", label), v("Annotation", ""), v("Color", color), v("LaunchMode", 0), v("LaunchQuantisation", 0),
    `<TimeSignature><TimeSignatures><RemoteableTimeSignature Id="0">${v("Numerator", 4)}${v("Denominator", 4)}${v("Time", 0)}</RemoteableTimeSignature></TimeSignatures></TimeSignature>`,
    `<Envelopes><Envelopes /></Envelopes>`, v("Legato", false), v("Ram", false), `<GrooveSettings>${v("GrooveId", -1)}</GrooveSettings>`,
    v("Disabled", false), v("VelocityAmount", 0), v("IsWarped", true),
  ].join("");
}

function audioClip(t: AlsAudioTrack, bpm: number, loop: boolean): string {
  const seconds = t.frames / t.sampleRate;
  const beats = (seconds * bpm) / 60;
  return `<AudioClip Id="0" Time="0">${clipHead(0, beats, t.name, t.color, loop)}`
    + `<SampleRef><FileRef>${v("RelativePathType", 1)}${v("RelativePath", t.file)}${v("Path", "")}${v("Type", 1)}${v("LivePackName", "")}${v("LivePackId", "")}</FileRef>`
    + `${v("DefaultDuration", t.frames)}${v("DefaultSampleRate", t.sampleRate)}</SampleRef>`
    + `${v("WarpMode", WARP_MODE[t.warp])}${v("Sync", true)}${v("HiQ", true)}${v("Fade", false)}`
    + `${v("PitchCoarse", 0)}${v("PitchFine", 0)}${v("SampleVolume", 1)}`
    // rendered at the set's tempo from beat 0, so two markers place every beat
    + `<WarpMarkers><WarpMarker Id="0" SecTime="0" BeatTime="0" /><WarpMarker Id="1" SecTime="${num(seconds)}" BeatTime="${num(beats)}" /></WarpMarkers>`
    + `${v("MarkersGenerated", false)}${v("IsSongTempoLeader", false)}</AudioClip>`;
}

function midiClip(t: AlsMidiTrack, beats: number, loop: boolean): string {
  const byKey = new Map<number, AlsNote[]>();
  for (const n of t.notes) {
    const key = Math.max(0, Math.min(127, Math.round(n.pitch)));
    byKey.set(key, [...(byKey.get(key) ?? []), n]);
  }
  let id = 1;
  const keys = [...byKey.keys()].sort((a, b) => a - b).map((key, k) => {
    const notes = byKey.get(key)!.sort((a, b) => a.time - b.time).map((n) => {
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
      return `<MidiNoteEvent Time="${num(n.time)}" Duration="${num(Math.max(1 / 64, n.duration))}" Velocity="${vel}" VelocityDeviation="0" OffVelocity="64" Probability="1" IsEnabled="true" NoteId="${id++}" />`;
    });
    return `<KeyTrack Id="${k}"><Notes>${notes.join("")}</Notes>${v("MidiKey", key)}</KeyTrack>`;
  });
  return `<MidiClip Id="0" Time="0">${clipHead(0, beats, t.name, t.color, loop)}`
    + `<Notes><KeyTracks>${keys.join("")}</KeyTracks><NoteIdGenerator>${v("NextId", id)}</NoteIdGenerator></Notes>`
    + `${v("BankSelectCoarse", -1)}${v("BankSelectFine", -1)}${v("ProgramChange", -1)}</MidiClip>`;
}

/**
 * Session view: Live expects every track to have a slot for every scene, and at
 * least one scene. Without them it loads the set and then crashes when it looks
 * for the selected clip.
 */
const SCENES = 8;
const slots = () => `<ClipSlotList>${Array.from({ length: SCENES }, (_, i) => `<ClipSlot Id="${i}">${v("LomId", 0)}<ClipSlot><Value /></ClipSlot>${v("HasStop", true)}${v("NeedRefreeze", true)}</ClipSlot>`).join("")}</ClipSlotList>`;
const scenes = () => `<Scenes>${Array.from({ length: SCENES }, (_, i) => `<Scene Id="${i}">${v("Name", "")}${v("Annotation", "")}${v("Color", -1)}${v("Tempo", 120)}${v("IsTempoEnabled", false)}${v("TimeSignatureId", 201)}${v("IsTimeSignatureEnabled", false)}${v("LomId", 0)}</Scene>`).join("")}</Scenes>`;
/** A frozen track's own sequencer, empty until Live freezes it. */
const freezer = () => `<FreezeSequencer>${slots()}<Sample><ArrangerAutomation><Events /></ArrangerAutomation></Sample></FreezeSequencer>`;

/** The XML of the set. */
export function liveSetXml(set: AlsSet): string {
  let trackId = 20;
  const audio = set.audio.map((t) => `<AudioTrack Id="${trackId++}">${name(t.name)}${v("Color", t.color)}${v("TrackGroupId", -1)}`
    + `<DeviceChain><MainSequencer>${slots()}<Sample><ArrangerAutomation><Events>${audioClip(t, set.bpm, !!set.loop)}</Events></ArrangerAutomation></Sample></MainSequencer>${freezer()}</DeviceChain></AudioTrack>`);
  const midi = set.midi.map((t) => `<MidiTrack Id="${trackId++}">${name(t.name)}${v("Color", t.color)}${v("TrackGroupId", -1)}`
    + `<DeviceChain><MainSequencer>${slots()}<ClipTimeable><ArrangerAutomation><Events>${midiClip(t, set.beats, !!set.loop)}</Events></ArrangerAutomation></ClipTimeable></MainSequencer>${freezer()}</DeviceChain></MidiTrack>`);
  const locators = set.locators.map((l, i) => `<Locator Id="${i}">${v("LomId", 0)}${v("Time", l.time)}${v("Name", l.name)}${v("Annotation", "")}${v("IsSongStart", false)}</Locator>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<Ableton MajorVersion="5" MinorVersion="12.0_12117" SchemaChangeCount="10" Creator="Ableton Live 12.1" Revision="">`
    + `<LiveSet>${v("NextPointeeId", 100000)}${v("OverwriteProtectionNumber", 3072)}`
    + `<Tracks>${audio.join("")}${midi.join("")}</Tracks>`
    + `<MainTrack><DeviceChain><Mixer><Tempo>${v("LomId", 0)}${v("Manual", set.bpm)}</Tempo><TimeSignature>${v("LomId", 0)}${v("Manual", 201)}</TimeSignature></Mixer></DeviceChain></MainTrack>`
    + scenes()
    + `<Transport>${v("LoopOn", !!set.loop)}${v("LoopStart", 0)}${v("LoopLength", set.beats)}${v("LoopIsSongStart", false)}${v("CurrentTime", 0)}</Transport>`
    + `<Locators><Locators>${locators.join("")}</Locators></Locators>`
    + `</LiveSet></Ableton>\n`;
}

/** Gzip, as Live reads a set. The browser's own compressor where there is one. */
export async function gzip(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
