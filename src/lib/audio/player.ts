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
import { allSamplesFor } from "./kits";
import { sampleBank } from "./samples";
import { automate, makeRuntime, startAtmosphere, trigger, type Runtime } from "./voices";

type Scheduled = { time: number; note?: NoteEvent; auto?: Automation };

const TICK_MS = 25;
const LOOKAHEAD = 0.18;
const LOOKAHEAD_HIDDEN = 1.3; // background tabs throttle timers to about 1 Hz

export interface Levels { low: number; mid: number; high: number; level: number }
export interface LoopRange { start: number; end: number }

export class Player {
  ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private rt: Runtime | null = null;
  private track: Track | null = null;
  private events: Scheduled[] = [];
  private cursor = 0;            // index of the next event
  private segTime = 0;           // audio time the current pass through the loop began
  private segPos = 0;            // track position at segTime
  private passStart: { time: number; pos: number }[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = new Set<AudioBufferSourceNode>();
  private atmos: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private wave: Float32Array<ArrayBuffer> | null = null;
  private muted = new Set<ChannelId>();
  private soloed = new Set<ChannelId>();
  private rate = 0;
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

  async prepare(style: Track["config"]["style"], tonality: Track["tonality"], onProgress?: (p: number) => void): Promise<void> {
    await sampleBank.ensure(this.context(), allSamplesFor(style, tonality), onProgress);
  }

  private ensureGraph(track: Track): Graph {
    const ctx = this.context();
    if (!this.graph) {
      this.graph = buildGraph(ctx, sampleBank);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      this.graph.out.connect(this.analyser);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.applyStrips();
    }
    return this.graph;
  }

  /** Load a track. If it is playing, the new one takes over at the same bar position. */
  setTrack(track: Track): void {
    const wasPlaying = this.playing;
    const fraction = this.track && this.track.durationSec > 0 ? this.position() / this.track.durationSec : 0;
    this.track = track;
    const graph = this.ensureGraph(track);
    applyMix(graph, track.mix, track.stepSec * 4, this.context().currentTime);
    this.rt = makeRuntime(this.context(), graph, sampleBank, track, this.active);
    this.events = [
      ...track.notes.map((note) => ({ time: note.startTime, note })),
      ...track.automation.map((auto) => ({ time: auto.time, auto })),
    ].sort((a, b) => a.time - b.time);
    if (this.range) this.range = null;
    if (wasPlaying) this.seek(fraction * track.durationSec, true);
  }

  /** Swap notes only: an edit should not move the playhead or reset the mix. */
  updateNotes(notes: NoteEvent[]): void {
    if (!this.track) return;
    const pos = this.position();
    const merged = { ...this.track, notes };
    this.track = merged;
    if (this.rt) this.rt.track = merged;
    this.events = [
      ...notes.map((note) => ({ time: note.startTime, note })),
      ...merged.automation.map((auto) => ({ time: auto.time, auto })),
    ].sort((a, b) => a.time - b.time);
    if (this.playing) this.cursor = this.indexAt(Math.max(pos + LOOKAHEAD, this.nextPos()));
  }

  private nextPos(): number {
    return this.events[this.cursor]?.time ?? 0;
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
    this.startFrom(from);
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
    this.passStart = [{ time: when, pos }];
    this.cursor = this.indexAt(pos);
    this.restoreAutomation(pos, when);
    const g = this.graph!;
    g.out.gain.cancelScheduledValues(ctx.currentTime);
    g.out.gain.setTargetAtTime(OUTPUT_GAIN, ctx.currentTime, 0.008);
  }

  /** Set the mix moves as they would stand at `pos`, so a seek lands correctly. */
  private restoreAutomation(pos: number, time: number): void {
    const g = this.graph!;
    const track = this.track!;
    const latest: Partial<Record<Automation["param"], number>> = {};
    for (const a of track.automation) if (a.time <= pos) latest[a.param] = a.value;
    g.sweep.frequency.cancelScheduledValues(time);
    g.sweep.frequency.setValueAtTime(latest.cutoff ?? 18000, time);
    g.hallOut.gain.cancelScheduledValues(time);
    g.echoFb.gain.cancelScheduledValues(time);
    applyMix(g, track.mix, track.stepSec * 4, time);
    if (latest.space != null) g.hallOut.gain.setValueAtTime(latest.space, time);
    if (latest.echo != null) g.echoFb.gain.setValueAtTime(latest.echo, time);
    g.state.acidCutoff = latest.acid ?? 1;
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
        if (at >= horizon) return;
        if (at >= ctx.currentTime - 0.01) this.dispatch(next, at);
        this.cursor++;
        continue;
      }
      const wrapAt = this.segTime + (end - this.segPos);
      if (wrapAt >= horizon) return;
      if (!this.loop) {
        const left = Math.max(0, wrapAt - ctx.currentTime);
        clearInterval(this.timer);
        setTimeout(() => { this.stop(); this.onEnd(); }, left * 1000 + 40);
        return;
      }
      this.segTime = wrapAt;
      this.segPos = start;
      this.passStart.push({ time: wrapAt, pos: start });
      if (this.passStart.length > 4) this.passStart.shift();
      this.cursor = this.indexAt(start);
    }
  }

  private dispatch(e: Scheduled, time: number): void {
    if (!this.rt) return;
    if (e.note) trigger(this.rt, e.note, time);
    else if (e.auto) automate(this.rt, e.auto, time);
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
  }

  stop(): void {
    this.playing = false;
    clearInterval(this.timer);
    this.silence();
    this.segPos = 0;
    try { this.atmos?.stop(); } catch { /* not started */ }
    this.atmos = null;
  }

  /* ─────────────────────────── mute + solo ────────────────────────── */

  private applyStrips(): void {
    const g = this.graph;
    if (!g) return;
    const now = this.context().currentTime;
    for (const id of CHANNELS) {
      setChannel(g, id, this.soloed.size ? this.soloed.has(id) : !this.muted.has(id), now);
    }
  }

  setMute(id: ChannelId, on: boolean): void {
    if (on) this.muted.add(id); else this.muted.delete(id);
    this.applyStrips();
  }

  setSolo(id: ChannelId, on: boolean): void {
    if (on) this.soloed.add(id); else this.soloed.delete(id);
    this.applyStrips();
  }

  /** Live level bands from the master output, for the visuals. */
  levels(): Levels {
    if (!this.analyser || !this.freq || !this.wave || !this.ctx) return { low: 0, mid: 0, high: 0, level: 0 };
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    let sum = 0;
    for (const x of this.wave) sum += x * x;
    const db = 10 * Math.log10(sum / this.wave.length + 1e-9);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const band = (lo: number, hi: number) => {
      const a = Math.max(1, Math.round(lo / hz));
      const b = Math.max(a + 1, Math.round(hi / hz));
      let s = 0;
      for (let i = a; i < b; i++) s += this.freq![i];
      return s / (b - a) / 255;
    };
    return { low: band(30, 140), mid: band(300, 2500), high: band(5000, 14000), level: Math.max(0, Math.min(1, (db + 36) / 36)) };
  }
}

export const player = new Player();
export type { Lane };
