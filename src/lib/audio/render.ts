/**
 * lib/audio/render.ts
 *
 * Offline bounce through the same graph and voices as live playback, so the
 * exported file is the mix you heard. Stems keep the sidechain pump, because the
 * kick still runs through the graph; only its channel strip is muted.
 */

import type { NoteEvent, Track } from "../../types";
import { applyMix, buildGraph, CHANNELS, setChannel, type ChannelId } from "./graph";
import { allSamplesFor } from "./kits";
import { sampleBank } from "./samples";
import { automate, makeRuntime, startAtmosphere, trigger } from "./voices";

const TAIL_SEC = 3;
const CHUNK_SEC = 1;

export const STEM_GROUPS: Record<string, ChannelId[]> = {
  drums: ["drums", "perc"],
  rumble: ["rumble"],
  bass: ["bass"],
  chords: ["stab", "pad"],
  lead: ["lead"],
  fx: ["fx"],
};

/** Render a track to a buffer. `only` keeps those channels; the rest stay silent. */
export async function renderTrack(track: Track, sampleRate: number, only?: ChannelId[]): Promise<AudioBuffer> {
  const length = Math.ceil((track.durationSec + TAIL_SEC) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  await sampleBank.ensure(ctx, allSamplesFor(track.config.style, track.tonality));

  const graph = buildGraph(ctx, sampleBank);
  applyMix(graph, track.mix, track.stepSec * 4, 0);
  if (only) for (const id of CHANNELS) setChannel(graph, id, only.includes(id));
  else startAtmosphere(makeRuntime(ctx, graph, sampleBank, track), 0, track.durationSec);

  const rt = makeRuntime(ctx, graph, sampleBank, track);
  const start = 0.02;
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
  const end = length / sampleRate;
  if (typeof ctx.suspend === "function") {
    queueUntil(CHUNK_SEC);
    for (let t = CHUNK_SEC; t < end - 0.1; t += CHUNK_SEC) {
      void ctx.suspend(t).then(() => {
        queueUntil(t + CHUNK_SEC);
        return ctx.resume();
      });
    }
  } else {
    queueUntil(Infinity);
  }
  return ctx.startRendering();
}

/** Encode a buffer as 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const align = channels * 2;
  const size = frames * align;
  const ab = new ArrayBuffer(44 + size);
  const view = new DataView(ab);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };

  text(0, "RIFF"); view.setUint32(4, 36 + size, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * align, true); view.setUint16(32, align, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, size, true);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      at += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The arrangement as MIDI. Chord samples are written out as real chords. */
export async function encodeMidi(track: Track): Promise<Blob> {
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
    if (n.instrument === "fx") continue;
    for (const off of n.chord ?? [0]) add(n, n.pitch + off);
  }
  return new Blob([new Uint8Array(midi.toArray())], { type: "audio/midi" });
}
