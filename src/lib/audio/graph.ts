/**
 * lib/audio/graph.ts
 *
 * The studio signal path. One builder serves both the live AudioContext and the
 * OfflineAudioContext used for export, so a bounce is the same mix you hear.
 *
 *   kick ──────────► drum bus (drive, boom shelf) ──────────────────┐
 *   hats, claps ───►    ▲                                           │
 *                       room reverb ◄── perc ──► echo, hall         │
 *   808 kick ──► hall ──► distortion ──► sub filter ──► mono ──► duck ──┤
 *   bass ──► drive ──────────────────────────────────────────► duck ──┤
 *   stab, lead, pad ──► sweep filter ─────────────────────────► duck ──┤
 *                  └──► tape echo, hall ──────────────────────► duck ──┤
 *                                                                     ▼
 *                                 glue compressor ► soft clip ► limiter ► out
 *
 * The rumble is the classic techno chain: a long kick into a fully wet reverb,
 * distorted after the reverb, filtered down to the sub and ducked on every hit.
 */

import type { Lane, MixParams } from "../../types";
import type { SampleBank } from "./samples";

export type ChannelId = Lane | "rumble" | "fx";
export const CHANNELS: ChannelId[] = ["lead", "pad", "stab", "bass", "rumble", "perc", "drums", "fx"];

/** A channel's effect sends. They follow its mute, so a muted part leaves no echo. */
export interface Gates { hall: GainNode; echo: GainNode; room: GainNode }

export const OUTPUT_GAIN = 0.88;

export interface Graph {
  ctx:     BaseAudioContext;
  inputs:  Record<ChannelId, AudioNode>; // what voices connect to
  kickIn:  AudioNode;
  strips:  Record<ChannelId, GainNode>;  // mute / solo
  gates:   Record<ChannelId, Gates>;
  ducks:   GainNode[];                   // pumped on every kick
  sweep:   BiquadFilterNode;             // arrangement filter on the synth bus
  hallOut: GainNode;
  echoFb:  GainNode;
  echoTime: AudioParam;
  drive:   WaveShaperNode;
  drumsGain: GainNode;
  rumbleGain: GainNode;
  atmos:   GainNode;
  out:     GainNode;
  /** live state read by the voices */
  state:   { acidCutoff: number; brightness: number };
}

/** tanh waveshaper, normalised so full scale in is full scale out. */
export function softClip(amount: number, size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / (size - 1) - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, hz: number, q = 0.7, gain = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function shaper(ctx: BaseAudioContext, amount: number, oversample: OverSampleType = "2x"): WaveShaperNode {
  const w = ctx.createWaveShaper();
  w.curve = softClip(amount);
  w.oversample = oversample;
  return w;
}

function chain(...nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

function hallReverb(ctx: BaseAudioContext, bank: SampleBank, id: string): ConvolverNode {
  const c = ctx.createConvolver();
  c.buffer = bank.get(id);
  return c;
}

/** Dub-style tape delay: filtered, driven repeats with a slow wow in the time. */
function tapeEcho(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode; feedback: GainNode; time: AudioParam } {
  const input = gainNode(ctx, 1);
  const delay = ctx.createDelay(2);
  const low = filter(ctx, "highpass", 200);
  const high = filter(ctx, "lowpass", 4800);
  const warm = shaper(ctx, 1.6);
  const unity = gainNode(ctx, 0.58); // the saturator adds gain; inside a feedback loop that would ring forever
  const feedback = gainNode(ctx, 0.38);
  const output = gainNode(ctx, 1);

  const wow = ctx.createOscillator();
  wow.frequency.value = 0.37;
  const wowDepth = gainNode(ctx, 0.0011);
  chain(wow, wowDepth);
  wowDepth.connect(delay.delayTime);
  wow.start();

  chain(input, delay, low, high, warm, unity, output);
  chain(unity, feedback, delay);
  return { input, output, feedback, time: delay.delayTime };
}

export function buildGraph(ctx: BaseAudioContext, bank: SampleBank): Graph {
  /* master */
  const masterIn = gainNode(ctx, 0.46);
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.ratio.value = 2;
  glue.attack.value = 0.022; // slow enough to let the kick's click through
  glue.release.value = 0.14;
  glue.knee.value = 8;
  const clip = shaper(ctx, 1.1, "4x");
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.5;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  limiter.knee.value = 0;
  const out = gainNode(ctx, OUTPUT_GAIN);
  chain(masterIn, glue, clip, limiter, out, ctx.destination);

  /* ducked buses */
  const duckSynth = gainNode(ctx, 1);
  const duckBass = gainNode(ctx, 1);
  const duckRumble = gainNode(ctx, 1);
  const duckWet = gainNode(ctx, 1);
  for (const d of [duckSynth, duckBass, duckRumble, duckWet]) d.connect(masterIn);

  /* channel strips */
  const strip = () => gainNode(ctx, 1);
  const strips = { lead: strip(), pad: strip(), stab: strip(), bass: strip(), rumble: strip(), perc: strip(), drums: strip(), fx: strip() };

  /* drums */
  const kickIn = gainNode(ctx, 1);
  const kickHp = filter(ctx, "highpass", 42); // the rumble carries the deepest sub
  const drumsIn = gainNode(ctx, 1);
  const drive = shaper(ctx, 1.4);
  const boom = filter(ctx, "lowshelf", 55, 0.7, 3);
  const drumsGain = gainNode(ctx, 1);
  chain(kickIn, kickHp, strips.drums);
  drumsIn.connect(strips.drums);
  chain(strips.drums, drive, boom, drumsGain, masterIn);

  const percIn = gainNode(ctx, 1);
  chain(percIn, strips.perc, masterIn);

  /* rumble: reverb first, distortion after, then only the sub survives */
  const rumbleIn = gainNode(ctx, 1);
  const rumbleVerb = hallReverb(ctx, bank, "ir_hall");
  const rumblePre = gainNode(ctx, 1.8);
  const rumbleDrive = shaper(ctx, 3.2, "4x");
  const rumbleLp1 = filter(ctx, "lowpass", 170, 0.9);
  const rumbleLp2 = filter(ctx, "lowpass", 170, 0.7);
  const rumbleHp = filter(ctx, "highpass", 30);
  const rumbleMono = gainNode(ctx, 1);
  rumbleMono.channelCount = 1;
  rumbleMono.channelCountMode = "explicit";
  rumbleMono.channelInterpretation = "speakers";
  const rumbleGain = gainNode(ctx, 0.4);
  chain(rumbleIn, rumbleVerb, rumblePre, rumbleDrive, rumbleLp1, rumbleLp2, rumbleHp, rumbleMono, strips.rumble, rumbleGain, duckRumble);

  /* bass */
  const bassIn = gainNode(ctx, 1);
  const bassHp = filter(ctx, "highpass", 34);
  const bassDrive = shaper(ctx, 2.2, "4x");
  chain(bassIn, bassHp, bassDrive, strips.bass, duckBass);

  /* synth bus */
  const sweep = filter(ctx, "lowpass", 18000, 0.9);
  const synthBus = gainNode(ctx, 1.25);
  const stabIn = gainNode(ctx, 1);
  const leadIn = gainNode(ctx, 1);
  const padIn = gainNode(ctx, 1);
  chain(stabIn, strips.stab, synthBus);
  chain(leadIn, strips.lead, synthBus);
  chain(padIn, strips.pad, synthBus);
  chain(synthBus, sweep, duckSynth);

  /* sends */
  const hallIn = gainNode(ctx, 1);
  const hallHp = filter(ctx, "highpass", 240);
  const hallLp = filter(ctx, "lowpass", 7000);
  const hallOut = gainNode(ctx, 0.5);
  chain(hallIn, hallHp, hallLp, hallReverb(ctx, bank, "ir_hall"), hallOut, duckWet);

  const roomIn = gainNode(ctx, 1);
  const roomHp = filter(ctx, "highpass", 320);
  chain(roomIn, roomHp, hallReverb(ctx, bank, "ir_room"), gainNode(ctx, 0.8), masterIn);

  // the repeats land on opposite sides, a beat of air apart, for width
  const echo = tapeEcho(ctx);
  const echoLeft = ctx.createStereoPanner();
  const echoRight = ctx.createStereoPanner();
  const echoLate = ctx.createDelay(0.2);
  echoLeft.pan.value = -0.75;
  echoRight.pan.value = 0.75;
  echoLate.delayTime.value = 0.023;
  const echoLevel = gainNode(ctx, 1);
  chain(echo.output, echoLevel, echoLeft, duckWet);
  chain(echoLevel, echoLate, echoRight, duckWet);

  const fxIn = gainNode(ctx, 1);
  chain(fxIn, strips.fx, masterIn);

  const atmos = gainNode(ctx, 0.05);
  atmos.connect(masterIn);

  const gate = (to: AudioNode) => {
    const g = gainNode(ctx, 1);
    g.connect(to);
    return g;
  };
  const gates = Object.fromEntries(CHANNELS.map((id) => [id, { hall: gate(hallIn), echo: gate(echo.input), room: gate(roomIn) }])) as Record<ChannelId, Gates>;

  return {
    ctx,
    inputs: { lead: leadIn, pad: padIn, stab: stabIn, bass: bassIn, rumble: rumbleIn, perc: percIn, drums: drumsIn, fx: fxIn },
    kickIn,
    strips,
    gates,
    ducks: [duckSynth, duckBass, duckRumble, duckWet],
    sweep,
    hallOut,
    echoFb: echo.feedback,
    echoTime: echo.time,
    drive,
    drumsGain,
    rumbleGain,
    atmos,
    out,
    state: { acidCutoff: 1, brightness: 0.5 },
  };
}

/** Switch a channel and its sends on or off. */
export function setChannel(g: Graph, id: ChannelId, on: boolean, time?: number): void {
  const nodes = [g.strips[id], g.gates[id].hall, g.gates[id].echo, g.gates[id].room];
  for (const n of nodes) {
    if (time == null) n.gain.value = on ? 1 : 0;
    else n.gain.setTargetAtTime(on ? 1 : 0, time, 0.01);
  }
}

/** Apply the mix derived from the controls. Works before and during playback. */
export function applyMix(g: Graph, mix: MixParams, beatSec: number, time = 0): void {
  g.echoTime.setValueAtTime(beatSec * 0.75, time); // dotted eighth, locked to the tempo
  g.drive.curve = softClip(1 + mix.drive * 3.2);
  g.drumsGain.gain.setValueAtTime(1 - mix.drive * 0.16, time);
  g.rumbleGain.gain.setValueAtTime(0.16 + mix.rumble * 0.44, time);
  g.hallOut.gain.setValueAtTime(0.2 + mix.space * 0.65, time);
  g.echoFb.gain.setValueAtTime(0.25 + mix.echo * 0.34, time);
  g.state.brightness = mix.brightness;
}
