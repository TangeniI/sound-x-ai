/**
 * lib/audio/player.ts
 *
 * Live playback: a lookahead scheduler over the track's sorted events, with
 * looping, seeking, mute / solo and level metering. Timers are too jittery to
 * trigger audio directly, so each tick queues the next stretch of events on the
 * audio clock.
 */

import type { Automation, Lane, NoteEvent, Track } from "../../types";
import { applyMix, buildGraph, CHANNELS, OUTPUT_GAIN, setChannel, type ChannelId, type Graph } from "./graph";
import { trackSamples } from "./kits";
import { sampleBank } from "./samples";
import { automate, makeRuntime, resumeAutomation, startAtmosphere, trigger, type Runtime } from "./voices";

type Scheduled = { time: number; note?: NoteEvent; auto?: Automation };

const TICK_MS = 25;
const LOOKAHEAD = 0.18;
const LOOKAHEAD_HIDDEN = 2.2; // background tabs throttle timers to about 1 Hz

export interface LoopRange { start: number; end: number }

/** Something that follows playback on the audio clock, such as MIDI out. */
export interface PlaybackListener {
  /** Playback starts, or jumps, at `time` from `pos` seconds into the track. */
  start(time: number, pos: number, track: Track): void;
  /** Events are queued up to `until`, at this track's tempo. */
  advance(until: number, track: Track): void;
  /** An audible note, at the audio time it sounds. */
  note(n: NoteEvent, time: number): void;
  /** Playback stops or is cut, at `time`. */
  stop(time: number): void;
}

export class Player {
  ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private rt: Runtime | null = null;
  private track: Track | null = null;
  private events: Scheduled[] = [];
  private cursor = 0;            // index of the next event
  private queuedUntil = 0;       // audio time up to which events have been handed over
  private segTime = 0;           // audio time the current pass through the loop began
  private segPos = 0;            // track position at segTime
  private passStart: { time: number; pos: number }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = new Set<AudioBufferSourceNode>();
  private atmos: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private bins: Float32Array<ArrayBuffer> | null = null;
  private muted = new Set<ChannelId>();
  private soloed = new Set<ChannelId>();
  private levels: Partial<Record<ChannelId, number>> = {};
  private rate = 0;
  private heard = new Set<ChannelId>(CHANNELS);
  private monitor: GainNode | null = null;
  listener: PlaybackListener | null = null;
  playing = false;
  loop = true;
  range: LoopRange | null = null;
  onEnd: () => void = () => {};

  /** The context exists from page load, so samples can decode before any click. */
  context(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: "playback" });
    }
    return this.ctx;
  }

  /** Browsers only start audio from a user gesture, so call this first in the handler. */
  unlock(): void {
    const ctx = this.context();
    if (ctx.state === "suspended") void ctx.resume();
  }

  async prepare(track: Track, onProgress?: (p: number) => void): Promise<void> {
    const ctx = this.context();
    await sampleBank.at(ctx.sampleRate).ensure(ctx, trackSamples(track), onProgress);
  }

  private ensureGraph(track: Track): Graph {
    const ctx = this.context();
    if (!this.graph) {
      this.graph = buildGraph(ctx, sampleBank.at(ctx.sampleRate));
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 8192; // enough to tell the kick from the sub
      this.analyser.smoothingTimeConstant = 0.55;
      // through a switch of its own, so MIDI out can play without the browser's sound
      this.graph.out.disconnect();
      this.monitor = ctx.createGain();
      this.graph.out.connect(this.monitor).connect(ctx.destination);
      this.graph.out.connect(this.analyser);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.bins = new Float32Array(this.analyser.frequencyBinCount);
      this.applyStrips();
    }
    return this.graph;
  }

  /**
   * Load a track. While playing, it takes over where the queued audio ends, at
   * the same step, so moving a control never cuts the sound.
   */
  setTrack(track: Track): void {
    const old = this.track;
    const now = this.context().currentTime;
    const at = Math.max(now + 0.01, this.queuedUntil);
    const scale = old ? track.stepSec / old.stepSec : 1;
    const oldPos = this.playing ? this.segPos + (at - this.segTime) : this.segPos;

    this.track = track;
    this.levels = { ...track.config.levels };
    const graph = this.ensureGraph(track);
    this.applyStrips();
    const previous = this.rt;
    this.rt = makeRuntime(this.context(), graph, sampleBank.at(this.context().sampleRate), track, this.active);
    this.rt.openHat = previous?.openHat;
    this.setEvents(track);
    if (this.range) {
      const start = this.range.start * scale;
      const end = Math.min(track.durationSec, this.range.end * scale);
      this.range = end > start ? { start, end } : null;
    }

    let pos = oldPos * scale;
    if (pos >= track.durationSec) pos = this.playing && track.durationSec ? pos % track.durationSec : 0;
    if (!this.playing) {
      this.segPos = pos;
      applyMix(graph, track.mix, track.stepSec * 4, now);
      return;
    }
    this.segTime = at;
    this.segPos = pos;
    this.addPass(at, pos);
    this.cursor = this.indexAt(pos);
    this.restoreAutomation(pos, at);
  }

  /** Swap notes only: an edit should not move the playhead or reset the mix. */
  updateNotes(notes: NoteEvent[]): void {
    if (!this.track) return;
    const merged = { ...this.track, notes };
    this.track = merged;
    if (this.rt) this.rt.track = merged;
    this.setEvents(merged);
    if (this.playing) this.cursor = this.indexAt(this.segPos + (this.queuedUntil - this.segTime));
  }

  private setEvents(track: Track): void {
    this.events = [
      ...track.notes.map((note) => ({ time: note.startTime, note })),
      ...track.automation.map((auto) => ({ time: auto.time, auto })),
    ].sort((a, b) => a.time - b.time);
  }

  private addPass(time: number, pos: number): void {
    this.passStart.push({ time, pos });
    if (this.passStart.length > 8) this.passStart.shift();
  }

  private indexAt(pos: number): number {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private bounds(): LoopRange {
    return this.range ?? { start: 0, end: this.track?.durationSec ?? 0 };
  }

  async play(from = 0): Promise<void> {
    const ctx = this.context();
    if (!this.track) return;
    await ctx.resume();
    this.ensureGraph(this.track);
    this.silence();
    const { start, end } = this.bounds();
    const outside = this.range ? from < start : false;
    this.startFrom(!outside && from < end - 0.05 ? from : start);
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (!this.atmos && this.rt) this.atmos = startAtmosphere(this.rt, ctx.currentTime);
    this.tick();
  }

  private startFrom(pos: number): void {
    const ctx = this.context();
    const when = ctx.currentTime + 0.06;
    this.segTime = when;
    this.segPos = pos;
    this.queuedUntil = when;
    this.passStart = [{ time: when, pos }];
    this.cursor = this.indexAt(pos);
    this.restoreAutomation(pos, when);
    this.listener?.start(when, pos, this.track!);
    const g = this.graph!;
    // after the fade-out that silence() queued, not over the top of it
    g.out.gain.setTargetAtTime(OUTPUT_GAIN, when - 0.012, 0.004);
  }

  /** Set the mix moves as they would stand at `pos`, so a seek lands correctly. */
  private restoreAutomation(pos: number, time: number): void {
    const g = this.graph!;
    const track = this.track!;
    for (const p of [g.sweep.frequency, g.hallOut.gain, g.echoFb.gain, g.lowGate.gain]) {
      // hold where a half-finished ramp would be; Firefox can only cancel it
      if (typeof p.cancelAndHoldAtTime === "function") p.cancelAndHoldAtTime(time);
      else p.cancelScheduledValues(time);
    }
    applyMix(g, track.mix, track.stepSec * 4, time);
    const latest = new Map<Automation["param"], Automation>();
    for (const a of track.automation) if (a.time <= pos) latest.set(a.param, a);
    for (const a of latest.values()) resumeAutomation(g, a, pos, time);
  }

  private tick(): void {
    if (!this.playing || !this.rt) return;
    const ctx = this.context();
    const horizon = ctx.currentTime + (document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    const { start, end } = this.bounds();
    for (;;) {
      const next = this.events[this.cursor];
      if (next && next.time < end) {
        const at = this.segTime + (next.time - this.segPos);
        if (at >= horizon) break;
        if (at >= ctx.currentTime - 0.01) this.dispatch(next, at);
        this.cursor++;
        continue;
      }
      const wrapAt = this.segTime + (end - this.segPos);
      if (wrapAt >= horizon) break;
      if (!this.loop) {
        // checked on each tick, so a seek, replay or loop change cancels the ending
        if (ctx.currentTime >= wrapAt) {
          this.stop();
          this.onEnd();
          return;
        }
        break;
      }
      this.segTime = wrapAt;
      this.segPos = start;
      this.addPass(wrapAt, start);
      this.cursor = this.indexAt(start);
      this.restoreAutomation(start, wrapAt);
    }
    this.queuedUntil = Math.max(this.queuedUntil, horizon);
    this.listener?.advance(horizon, this.track!);
  }

  private dispatch(e: Scheduled, time: number): void {
    if (!this.rt) return;
    if (e.note) {
      trigger(this.rt, e.note, time);
      if (this.listener && this.heard.has(e.note.instrument as ChannelId)) this.listener.note(e.note, time);
    } else if (e.auto) automate(this.rt, e.auto, time);
  }

  /** Whether the browser's own sound plays. MIDI out goes on either way. */
  setSpeaker(on: boolean): void {
    const ctx = this.context();
    this.monitor?.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.01);
  }

  /** Current position in seconds, read from the audio clock. */
  position(): number {
    if (!this.playing || !this.ctx) return this.segPos;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0);
    let pass = this.passStart[0];
    for (const p of this.passStart) if (p.time <= now) pass = p;
    if (!pass) return 0;
    return Math.max(pass.pos, pass.pos + (now - pass.time));
  }

  seek(pos: number, keepPlaying = this.playing): void {
    const clamped = Math.max(0, Math.min(pos, this.track?.durationSec ?? 0));
    if (!keepPlaying) {
      this.segPos = clamped;
      return;
    }
    this.silence();
    this.startFrom(clamped);
    this.tick();
  }

  /** Loop part of the track, or pass null for all of it. */
  setRange(range: LoopRange | null): void {
    this.range = range;
    if (range) {
      this.loop = true;
      if (this.playing) {
        const pos = this.position();
        if (pos < range.start || pos >= range.end) this.seek(range.start);
      }
    }
  }

  /** Cut everything already queued, with a short fade so nothing clicks. */
  private silence(): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    g.out.gain.cancelScheduledValues(now);
    g.out.gain.setTargetAtTime(0, now, 0.006);
    for (const src of this.active) {
      try { src.stop(now + 0.04); } catch { /* already finished */ }
    }
    this.active.clear();
    for (const d of g.ducks) {
      d.gain.cancelScheduledValues(now);
      d.gain.setValueAtTime(1, now);
    }
    if (this.rt) {
      this.rt.openHat = undefined;
      this.rt.lastBassRate = undefined;
    }
    this.listener?.stop(now);
  }

  stop(): void {
    this.playing = false;
    clearInterval(this.timer);
    this.silence();
    this.segPos = this.range?.start ?? 0;
    try { this.atmos?.stop(); } catch { /* not started */ }
    this.atmos = null;
  }

  /* ─────────────────────────── mute + solo ────────────────────────── */

  private applyStrips(): void {
    this.heard = this.audible();
    const g = this.graph;
    if (!g) return;
    const now = this.context().currentTime;
    const on = this.audible();
    for (const id of CHANNELS) setChannel(g, id, on.has(id), now, this.levels[id] ?? 0);
  }

  /** Move a fader, in dB, without rebuilding anything. */
  setLevel(id: ChannelId, db: number): void {
    this.levels[id] = db;
    this.applyStrips();
  }

  /** The channels mute and solo leave playing. Exports use the same answer. */
  audible(): Set<ChannelId> {
    return new Set(CHANNELS.filter((id) => (this.soloed.size ? this.soloed.has(id) : !this.muted.has(id))));
  }

  setMute(id: ChannelId, on: boolean): void {
    if (on) this.muted.add(id); else this.muted.delete(id);
    this.applyStrips();
  }

  setSolo(id: ChannelId, on: boolean): void {
    if (on) this.soloed.add(id); else this.soloed.delete(id);
    this.applyStrips();
  }

  /** The master spectrum in dB, one value per bin of `hz`. */
  spectrum(): { db: Float32Array; hz: number; floor: number; top: number } | null {
    if (!this.analyser || !this.bins || !this.ctx) return null;
    this.analyser.getFloatFrequencyData(this.bins);
    return { db: this.bins, hz: this.ctx.sampleRate / this.analyser.fftSize, floor: -100, top: -15 };
  }

  /** Output level for the transport meter. */
  level(): number {
    if (!this.analyser || !this.wave) return 0;
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (const x of this.wave) sum += x * x;
    const db = 10 * Math.log10(sum / this.wave.length + 1e-9);
    return Math.max(0, Math.min(1, (db + 36) / 36));
  }
}

export const player = new Player();
export type { Lane };
