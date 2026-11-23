/**
 * lib/midi.ts
 *
 * MIDI out: the track plays the producer's own drum machine, synth or DAW
 * instruments, and can send clock so the DAW follows the tempo. Notes are sent
 * with timestamps taken from the audio clock, so they land with what the browser
 * plays. Chrome, Edge and Firefox have Web MIDI; Safari doesn't.
 *
 * On a Mac, the IAC Driver (Audio MIDI Setup → MIDI Studio → IAC Driver →
 * "Device is online") gives a port that any DAW, Live Intro included, can take in.
 */

import type { PlaybackListener } from "./audio/player";
import type { Lane, NoteEvent, Track } from "../types";

/** Channels 1–16 as the bytes count them, 0–15. Drums and percussion share the GM drum channel. */
export const CHANNELS: Record<Lane, number> = { lead: 0, pad: 1, stab: 2, bass: 3, perc: 9, drums: 9 };

export interface Message { data: number[]; time: number } // time on the audio clock, in seconds

const DRUM_LENGTH = 0.06;

/** Note on and off for one note, a stab's chord included. FX aren't notes an instrument can play. */
export function noteMessages(n: NoteEvent, time: number, channels = CHANNELS): Message[] {
  const lane = n.instrument as Lane;
  if (!(lane in channels)) return [];
  const ch = channels[lane];
  const velocity = Math.max(1, Math.min(127, Math.round(n.velocity)));
  const drum = lane === "drums" || lane === "perc";
  const length = drum ? DRUM_LENGTH : Math.max(0.02, n.endTime - n.startTime - 0.005);
  return (n.chord ?? [0]).flatMap((off) => {
    const pitch = n.pitch + off;
    if (pitch < 0 || pitch > 127) return [];
    return [
      { data: [0x90 | ch, pitch, velocity], time },
      { data: [0x80 | ch, pitch, 0], time: time + length },
    ];
  });
}

/** Song position, in 16ths, as the two 7-bit bytes after 0xF2. */
export function songPosition(pos: number, stepSec: number): number[] {
  const sixteenths = Math.max(0, Math.min(0x3fff, Math.round(pos / stepSec)));
  return [0xf2, sixteenths & 0x7f, sixteenths >> 7];
}

/** MIDI clock runs at 24 ticks a beat: 6 to a 16th. */
export const clockTick = (stepSec: number) => stepSec / 6;

type Output = { id: string; name: string | null; send(data: number[], timestamp?: number): void };
type Access = { outputs: Map<string, Output>; onstatechange: ((e: Event) => void) | null };

export const midiSupported = () => typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;

export class MidiOut implements PlaybackListener {
  private access: Access | null = null;
  private port: Output | null = null;
  private nextTick = 0;
  private ticking = false;
  private used = new Set<number>();
  clock = true;
  onPorts: (ports: { id: string; name: string }[]) => void = () => {};

  constructor(private ctx: () => AudioContext) {}

  /** Ask for MIDI. The browser shows its own permission prompt. */
  async connect(): Promise<{ id: string; name: string }[]> {
    if (!midiSupported()) throw new Error("This browser has no Web MIDI. Use Chrome, Edge or Firefox.");
    const access = (await (navigator as unknown as { requestMIDIAccess(o: object): Promise<Access> }).requestMIDIAccess({ sysex: false }));
    this.access = access;
    access.onstatechange = () => this.onPorts(this.ports());
    return this.ports();
  }

  ports(): { id: string; name: string }[] {
    return this.access ? [...this.access.outputs.values()].map((o) => ({ id: o.id, name: o.name ?? o.id })) : [];
  }

  select(id: string | null): void {
    this.allOff();
    this.port = (id && this.access?.outputs.get(id)) || null;
  }

  get selected(): string | null {
    return this.port?.id ?? null;
  }

  /** Audio time to the performance clock MIDI timestamps use, at the moment it's heard. */
  private at(time: number): number {
    const ctx = this.ctx();
    if (typeof ctx.getOutputTimestamp === "function") {
      const { contextTime, performanceTime } = ctx.getOutputTimestamp();
      if (contextTime != null && performanceTime) return performanceTime + (time - contextTime) * 1000;
    }
    return performance.now() + (time - ctx.currentTime + (ctx.outputLatency || 0)) * 1000;
  }

  private send(data: number[], time: number): void {
    try {
      this.port?.send(data, Math.max(performance.now(), this.at(time)));
    } catch {
      // a port that went away mid-play; the next state change updates the list
    }
  }

  start(time: number, pos: number, track: Track): void {
    if (!this.port) return;
    if (this.clock) {
      this.send(songPosition(pos, track.stepSec), time - 0.002);
      this.send([pos < track.stepSec / 2 ? 0xfa : 0xfb], time - 0.001);
      this.nextTick = time;
      this.ticking = true;
    }
  }

  advance(until: number, track: Track): void {
    if (!this.port || !this.clock || !this.ticking) return;
    const tick = clockTick(track.stepSec);
    // never schedule a backlog: a throttled tab jumps ahead instead
    const now = this.ctx().currentTime;
    if (this.nextTick < now - 0.05) this.nextTick = now + ((this.nextTick - now) % tick + tick) % tick;
    for (; this.nextTick < until; this.nextTick += tick) this.send([0xf8], this.nextTick);
  }

  note(n: NoteEvent, time: number): void {
    if (!this.port) return;
    for (const m of noteMessages(n, time)) {
      this.used.add(m.data[0] & 0x0f);
      this.send(m.data, m.time);
    }
  }

  stop(time: number): void {
    if (!this.port) return;
    if (this.ticking && this.clock) this.send([0xfc], time);
    this.ticking = false;
    this.allOff(time);
  }

  /** All notes off, now and again once anything already queued has gone out. */
  private allOff(time?: number): void {
    if (!this.port) return;
    const now = time ?? this.ctx().currentTime;
    for (const ch of this.used) for (const t of [now, now + 2.4]) this.send([0xb0 | ch, 123, 0], t);
  }
}
