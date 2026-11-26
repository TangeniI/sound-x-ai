/**
 * lib/audio/render.ts
 *
 * Offline bounce through the same graph and voices as live playback, so the
 * exported file is the mix you heard, muted parts included. The processing's
 * own delay is measured and trimmed, so bar 1 is the first sample. Stems keep the
 * sidechain pump, because the kick still runs through the graph; only its channel
 * strip is muted. They keep the master's tone but not its compression or ceiling,
 * so together they rebuild the mix as it sounds before the master's dynamics.
 *
 * A loop is rendered twice in a row and the second pass kept, so what rings over
 * from its end is already at its start, as it will be when it repeats in a DAW.
 *
 * A full mix ends in a true-peak limiter (lib/audio/master.ts); a loop is limited
 * as a loop, so the gain at its end already leads into its start.
 */

import type { Lane, NoteEvent, Track } from "../../types";
import { sliceTrack, stemsFor, stemTrack } from "./slice";
import { makeZip, type ZipEntry } from "../zip";
import { chunk, encodeAiff, id3, pcm, riffInfo, type Tags } from "./tags";
import { encodeFlac } from "./flac";
import { applyMix, buildGraph, CHANNELS, setChannel, type ChannelId } from "./graph";
import { trackSamples } from "./kits";
import { sampleBank } from "./samples";
import { automate, makeRuntime, startAtmosphere, trigger } from "./voices";
import { truePeakLimit } from "./master";
import { gzip, liveSetXml, type AlsAudioTrack, type AlsMidiTrack } from "../ableton";
import { LANE_LABEL, SECTION_LABEL } from "../labels";

const TAIL_SEC = 3;
const CHUNK_SEC = 1;

export interface RenderOptions {
  /** A stem: just these channels, without the master processing. */
  only?:       ChannelId[];
  /** What mute and solo leave playing. Everything, if not given. */
  audible?:    ReadonlySet<ChannelId>;
  /** Fader levels in dB. The track's own, if not given. */
  levels?:     Partial<Record<ChannelId, number>>;
  /** Sample rate of the result. The live context's rate, if not given. */
  rate?:       number;
  /** Leave off the ring-out after the last bar. */
  noTail?:     boolean;
  /** Leave the peaks between samples alone (a loop limits once it is cut). */
  noLimit?:    boolean;
  onProgress?: (done: number) => void;
}

/** Room ahead of bar 1, because a note can't be scheduled before time zero. */
const LEAD_IN = 0.02;
const latencies = new Map<string, Promise<number>>();

/** How many samples late the kick's path comes out, measured with a click. */
function latencyOf(sampleRate: number, master: boolean): Promise<number> {
  const key = `${sampleRate}:${master}`;
  let found = latencies.get(key);
  if (found) return found;
  found = (async () => {
    const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * 0.25), sampleRate);
    const bank = sampleBank.at(sampleRate);
    await bank.ensure(ctx, ["ir_hall", "ir_room"]);
    const graph = buildGraph(ctx, bank, { master });
    const click = ctx.createBuffer(1, 64, sampleRate);
    click.getChannelData(0)[0] = 1;
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.connect(graph.kickIn);
    const at = Math.round(LEAD_IN * sampleRate);
    src.start(at / sampleRate);
    const data = (await ctx.startRendering()).getChannelData(0);
    let peak = at;
    for (let i = at; i < data.length; i++) if (Math.abs(data[i]) > Math.abs(data[peak])) peak = i;
    return peak - at;
  })();
  latencies.set(key, found);
  found.catch(() => latencies.delete(key));
  return found;
}

/**
 * Render a track to a buffer that starts on bar 1. A full mix then has its
 * peaks between samples held under -1 dBTP, which the graph's soft ceiling,
 * seeing only the samples themselves, can't promise.
 */
export async function renderTrack(track: Track, sampleRate: number, options: RenderOptions = {}): Promise<AudioBuffer> {
  const { only, audible, onProgress = () => {}, levels = track.config.levels ?? {}, noTail } = options;
  const rate = options.rate ?? sampleRate;
  const trim = Math.round(LEAD_IN * rate) + await latencyOf(rate, !only);
  const wanted = Math.ceil((track.durationSec + (noTail ? 0 : TAIL_SEC)) * rate);
  const length = wanted + trim;
  const ctx = new OfflineAudioContext(2, length, rate);
  const bank = sampleBank.at(rate);
  await bank.ensure(ctx, trackSamples(track));
  const plays = (id: ChannelId) => (!only || only.includes(id)) && (!audible || audible.has(id));

  const graph = buildGraph(ctx, bank, { master: !only });
  applyMix(graph, track.mix, track.stepSec * 4, 0);
  for (const id of CHANNELS) setChannel(graph, id, plays(id), undefined, levels[id] ?? 0);
  if (plays("fx")) startAtmosphere(makeRuntime(ctx, graph, bank, track), 0, track.durationSec);

  const rt = makeRuntime(ctx, graph, bank, track);
  const start = Math.round(LEAD_IN * rate) / rate;
  const events = [
    ...track.notes.map((note) => ({ time: note.startTime, note, auto: undefined })),
    ...track.automation.map((auto) => ({ time: auto.time, note: undefined, auto })),
  ].sort((a, b) => a.time - b.time);

  let next = 0;
  const queueUntil = (until: number) => {
    for (; next < events.length && events[next].time < until; next++) {
      const e = events[next];
      if (e.note) trigger(rt, e.note, e.time + start);
      else if (e.auto) automate(rt, e.auto, e.time + start);
    }
  };

  // Every connected node costs time on every audio block, even before it plays,
  // so queue a chunk at a time where the browser can pause an offline render.
  const end = length / rate;
  if (typeof ctx.suspend === "function") {
    queueUntil(CHUNK_SEC);
    for (let t = CHUNK_SEC; t < end - 0.1; t += CHUNK_SEC) {
      void ctx.suspend(t).then(() => {
        onProgress(t / end);
        queueUntil(t + CHUNK_SEC);
        return ctx.resume();
      });
    }
  } else {
    queueUntil(Infinity);
  }
  const full = await ctx.startRendering();
  const out = new AudioBuffer({ numberOfChannels: 2, length: wanted, sampleRate: rate });
  for (let c = 0; c < 2; c++) out.copyToChannel(full.getChannelData(c).subarray(trim, trim + wanted), c);
  if (!only && !options.noLimit) truePeakLimit([out.getChannelData(0), out.getChannelData(1)], { sampleRate: rate });
  return out;
}

/** Bars of a track as a seamless loop, exactly that long. */
export async function renderLoop(track: Track, startBar: number, bars: number, sampleRate: number, options: RenderOptions = {}): Promise<AudioBuffer> {
  const twice = sliceTrack(track, startBar, bars, 2);
  const audio = await renderTrack(twice, sampleRate, { ...options, noTail: true, noLimit: true });
  const len = bars * track.stepSec * 16;
  const from = Math.round(len * audio.sampleRate);
  const frames = Math.round(2 * len * audio.sampleRate) - from;
  const out = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: audio.sampleRate });
  for (let c = 0; c < 2; c++) out.copyToChannel(audio.getChannelData(c).subarray(from, from + frames), c);
  if (!options.only && !options.noLimit) {
    truePeakLimit([out.getChannelData(0), out.getChannelData(1)], { sampleRate: out.sampleRate, loop: true });
  }
  return out;
}

export interface Range { startBar: number; bars: number }

export type FileType = "wav" | "aiff" | "flac";
export const EXTENSION: Record<FileType, string> = { wav: "wav", aiff: "aif", flac: "flac" };

/** A buffer in the chosen file type. */
export function encodeAudio(buffer: AudioBuffer, type: FileType, bits: 16 | 24, tags?: Tags): Blob {
  return type === "flac" ? encodeFlac(buffer, bits, tags) : type === "aiff" ? encodeAiff(buffer, bits, tags) : encodeWav(buffer, bits, tags);
}
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/**
 * Every stem in one zip, all the same length. Each is rendered on its
 * own, so the progress counts stems as well as time.
 */
export async function stemsZip(
  track: Track, sampleRate: number, audible: ReadonlySet<ChannelId>, name: string,
  { range, bits = 24, rate, type = "wav", levels, onProgress = () => {} }: { range?: Range; bits?: 16 | 24; rate?: number; type?: FileType; levels?: RenderOptions["levels"]; onProgress?: (p: number, stem: string) => void },
): Promise<Blob> {
  const stems = stemsFor(track, audible);
  const files: ZipEntry[] = [];
  for (const [i, stem] of stems.entries()) {
    const part = stemTrack(track, stem);
    const options: RenderOptions = { only: stem.only, audible, levels, rate, onProgress: (p) => onProgress((i + p) / stems.length, stem.name) };
    const audio = range ? await renderLoop(part, range.startBar, range.bars, sampleRate, options) : await renderTrack(part, sampleRate, options);
    files.push({ name: `${name}/${String(i + 1).padStart(2, "0")}-${stem.name}.${EXTENSION[type]}`, data: await bytesOf(encodeAudio(audio, type, bits)) });
  }
  return makeZip(files);
}

/** Live colour indices, so the stems and parts read as groups in the arrangement. */
const STEM_COLOR: Record<string, number> = { kick: 14, "clap-snare": 15, "hats-cymbals": 16, perc: 17, "low-end": 1, music: 3, fx: 20 };
const LANE_ALS_COLOR: Record<Lane, number> = { drums: 16, perc: 17, bass: 1, stab: 3, pad: 4, lead: 5 };
const PITCHED = new Set(["low-end", "music", "fx"]);

/**
 * An Ableton Live project: the set, and its stems beside it in Samples/Imported.
 * Unzipped, the folder opens in Live 12 with the stems playing the mix, the parts
 * as MIDI clips to put instruments on, and the sections marked. The stems are
 * FLAC, which Live reads, so a whole track fits in a download.
 *
 * With a range, it is a loop instead: the stems rendered to repeat seamlessly,
 * clips that keep repeating as they are drawn out, and the set looping them.
 */
export async function abletonZip(
  track: Track, sampleRate: number, audible: ReadonlySet<ChannelId>, name: string,
  { range, bits = 24, rate, levels, onProgress = () => {} }: { range?: Range; bits?: 16 | 24; rate?: number; levels?: RenderOptions["levels"]; onProgress?: (p: number, stem: string) => void },
): Promise<Blob> {
  const folder = `${name} Project`;
  const stems = stemsFor(track, audible);
  const files: ZipEntry[] = [];
  const audio: AlsAudioTrack[] = [];
  for (const [i, stem] of stems.entries()) {
    const part = stemTrack(track, stem);
    const options: RenderOptions = { only: stem.only, audible, levels, rate, onProgress: (p) => onProgress((i + p) / stems.length, stem.name) };
    const buffer = range ? await renderLoop(part, range.startBar, range.bars, sampleRate, options) : await renderTrack(part, sampleRate, options);
    const file = `Samples/Imported/${String(i + 1).padStart(2, "0")}-${stem.name}.flac`;
    files.push({ name: `${folder}/${file}`, data: await bytesOf(encodeFlac(buffer, bits)) });
    audio.push({ name: stem.name, file, frames: buffer.length, sampleRate: buffer.sampleRate, warp: PITCHED.has(stem.name) ? "tones" : "beats", color: STEM_COLOR[stem.name] ?? 0 });
  }

  const beatsPerSec = track.bpm / 60;
  const span = range ? sliceTrack(track, range.startBar, range.bars) : track;
  const lanes = new Map<Lane, AlsMidiTrack>();
  for (const n of span.notes) {
    if (n.instrument === "fx" || !audible.has(n.instrument)) continue;
    const lane = n.instrument as Lane;
    if (!lanes.has(lane)) lanes.set(lane, { name: `${LANE_LABEL[lane]} MIDI`, notes: [], color: LANE_ALS_COLOR[lane] });
    for (const off of n.chord ?? [0]) {
      lanes.get(lane)!.notes.push({ pitch: n.pitch + off, time: n.startTime * beatsPerSec, duration: Math.max(0.05, n.endTime - n.startTime) * beatsPerSec, velocity: n.velocity });
    }
  }
  const order: Lane[] = ["drums", "perc", "bass", "stab", "pad", "lead"];
  const xml = liveSetXml({
    bpm: track.bpm,
    beats: range ? range.bars * 4 : Math.ceil((track.durationSec * beatsPerSec) / 4) * 4,
    loop: !!range,
    locators: span.sections.map((s) => ({ time: s.startBar * 4, name: SECTION_LABEL[s.kind] })),
    audio,
    midi: order.flatMap((l) => (lanes.has(l) ? [lanes.get(l)!] : [])),
  });
  files.unshift({ name: `${folder}/${name}.als`, data: await gzip(xml) });
  return makeZip(files);
}

/**
 * Tools for a DJ to layer in a set, not finished tracks: the drums of the peak as a
 * loop, the same without the kick, and the build into the first drop as one hit.
 * The rumble stays out, so they sit over another record's low end.
 */
export async function djToolsZip(
  track: Track, sampleRate: number, name: string, peak: Range,
  { bits = 24, rate, type = "wav", levels, tags, onProgress = () => {} }: { bits?: 16 | 24; rate?: number; type?: FileType; levels?: RenderOptions["levels"]; tags: (title: string) => Tags; onProgress?: (p: number, what: string) => void },
): Promise<Blob> {
  const drums = new Set<ChannelId>(["drums", "perc"]);
  const noKick = { ...track, notes: track.notes.map((n) => (n.instrument === "drums" && (n.pitch === 35 || n.pitch === 36) ? { ...n, velocity: 0 } : n)) };
  const build = track.sections.find((s) => s.kind === "build");
  const jobs: { file: string; render: (p: (x: number) => void) => Promise<AudioBuffer> }[] = [
    { file: `drums-${peak.bars}bars`, render: (p) => renderLoop(track, peak.startBar, peak.bars, sampleRate, { audible: drums, levels, rate, onProgress: p }) },
    { file: `tops-${peak.bars}bars`, render: (p) => renderLoop(noKick, peak.startBar, peak.bars, sampleRate, { audible: drums, levels, rate, onProgress: p }) },
  ];
  if (build) {
    jobs.push({
      file: `build-${build.bars}bars`,
      // the build and the downbeat it lands on, with its tail
      render: (p) => renderTrack(sliceTrack(track, build.startBar, build.bars + 1), sampleRate, { levels, rate, onProgress: p }),
    });
  }
  const files: ZipEntry[] = [];
  for (const [i, job] of jobs.entries()) {
    const audio = await job.render((p) => onProgress((i + p) / jobs.length, job.file));
    const title = `${name}-${job.file}`;
    files.push({ name: `${name}-dj-tools/${title}.${EXTENSION[type]}`, data: await bytesOf(encodeAudio(audio, type, bits, tags(title))) });
  }
  const drumsOnly = sliceTrack({ ...track, notes: track.notes.filter((n) => n.instrument === "drums" || n.instrument === "perc") }, peak.startBar, peak.bars);
  files.push({ name: `${name}-dj-tools/${name}-drums-${peak.bars}bars.mid`, data: new Uint8Array(await (await encodeMidi(drumsOnly)).arrayBuffer()) });
  return makeZip(files);
}

/** Encode a buffer as PCM WAV: 24-bit, or 16-bit with triangular dither. Tags add tempo and key for DJ software. */
export function encodeWav(buffer: AudioBuffer, bits: 16 | 24 = 24, tags?: Tags): Blob {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const align = channels * (bits / 8);
  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, 1, true); // PCM
  f.setUint16(2, channels, true);
  f.setUint32(4, rate, true);
  f.setUint32(8, rate * align, true);
  f.setUint16(12, align, true);
  f.setUint16(14, bits, true);
  const parts = [
    chunk("fmt ", fmt, true),
    chunk("data", pcm(buffer, bits, true), true),
    ...(tags ? [chunk("LIST", riffInfo(tags), true), chunk("id3 ", id3(tags), true)] : []),
  ];
  const head = new Uint8Array(12);
  const h = new DataView(head.buffer);
  head.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  h.setUint32(4, 4 + parts.reduce((n, p) => n + p.length, 0), true);
  head.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return new Blob([head, ...parts] as BlobPart[], { type: "audio/wav" });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The arrangement as MIDI. Stabs are written out note by note. */
export async function encodeMidi(track: Track, audible?: ReadonlySet<ChannelId>): Promise<Blob> {
  const { Midi } = await import("@tonejs/midi");
  const midi = new Midi();
  midi.header.setTempo(track.bpm);
  const parts: Record<string, ReturnType<typeof midi.addTrack>> = {};
  const part = (name: string) => {
    if (!parts[name]) {
      const t = midi.addTrack();
      t.name = name;
      if (name === "drums" || name === "perc") t.channel = 9;
      parts[name] = t;
    }
    return parts[name];
  };
  const add = (n: NoteEvent, pitch: number) => part(n.instrument).addNote({
    midi: pitch,
    time: n.startTime,
    duration: Math.max(0.05, n.endTime - n.startTime),
    velocity: n.velocity / 127,
  });
  for (const n of track.notes) {
    if (n.instrument === "fx" || (audible && !audible.has(n.instrument))) continue;
    for (const off of n.chord ?? [0]) add(n, n.pitch + off);
  }
  return new Blob([new Uint8Array(midi.toArray())], { type: "audio/midi" });
}
