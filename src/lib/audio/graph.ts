/**
 * lib/audio/graph.ts
 *
 * The studio signal path. One builder serves both the live AudioContext and the
 * OfflineAudioContext used for export, so a bounce is the same mix you hear.
 *
 *   kick ──► soft drive ─────────────────────────────────────────┐
 *   hats, claps ──► drive ──► width ─────────────────────────────┤
 *   perc ──► drive ──► width ──► room, echo, hall ───────────────┤
 *   808 kick ──► hall ──► drive ──► sub filter ──► mono ──► duck ┤
 *   bass: 808 tail + a recorded knock ──► soft drive ─────► duck ┤
 *   stab, seq, pad ──► sweep filter ──► width ────────────► duck ┤
 *                                                                ▼
 *                          sub filter ► tone ► glue ► soft ceiling ► out
 *
 * Two rules came out of measuring the first version. No shaper is ever fed past
 * the end of its curve, where a WaveShaper clips hard. And width is added only
 * to the side signal above the low end, so the mix folds to mono unchanged.
 *
 * The rumble is the classic techno chain: a long kick into a fully wet reverb,
 * distorted after the reverb, filtered down to the sub and ducked on every hit.
 */

import type { ChannelId, Lane, MixParams } from "../../types";
import type { SampleBank } from "./samples";

export type { ChannelId };
export const CHANNELS: ChannelId[] = ["lead", "pad", "stab", "bass", "rumble", "perc", "drums", "fx"];

/** A channel's effect sends. They follow its mute, so a muted part leaves no echo. */
export interface Gates { hall: GainNode; echo: GainNode; room: GainNode }

export const OUTPUT_GAIN = 0.795; // -2 dBFS, leaving room for peaks between samples
/** How far past full scale a saturator can be driven before its curve runs out. */
const HEADROOM = 4;

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
  lowGate: GainNode;                     // shuts the rumble before a hit
  atmos:   GainNode;
  out:     GainNode;
  /** live state read by the voices */
  state:   { acidCutoff: number; brightness: number };
}

/**
 * tanh saturation, normalised so full scale in is full scale out. The curve
 * reaches `range` times full scale, so peaks bend instead of hitting its end.
 */
export function softClip(amount: number, range = HEADROOM, size = 8193): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  const k = Math.max(0.01, amount);
  const norm = Math.tanh(k);
  for (let i = 0; i < size; i++) {
    const x = ((i * 2) / (size - 1) - 1) * range;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Untouched up to the knee, then a smooth bend towards full scale. */
export function ceilingCurve(knee = 0.5, range = HEADROOM, size = 8193): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = ((i * 2) / (size - 1) - 1) * range;
    const a = Math.abs(x);
    curve[i] = a <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
  }
  return curve;
}

/** The fixed makeup gain a DynamicsCompressor adds by itself, undone. */
export function undoMakeup(threshold: number, ratio: number): number {
  const atFullScale = threshold - threshold / ratio;
  return 10 ** ((atFullScale * 0.6) / 20);
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

interface Saturator { input: AudioNode; node: WaveShaperNode }

/** A WaveShaper reads only -1 to 1, so scale down into it. The curve scales back up. */
function saturator(ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>, oversample: OverSampleType = "2x"): Saturator {
  const input = gainNode(ctx, 1 / HEADROOM);
  const node = ctx.createWaveShaper();
  node.curve = curve;
  node.oversample = oversample;
  input.connect(node);
  return { input, node };
}

function chain(...nodes: AudioNode[]): void {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

/**
 * Width that folds away: a short delay of the signal is added on the left and
 * taken off the right, so the mono sum is exactly the dry signal.
 */
function widener(ctx: BaseAudioContext, seconds: number, amount: number, dest: AudioNode, from = 450): AudioNode {
  const input = gainNode(ctx, 1);
  const mono = gainNode(ctx, 1);
  mono.channelCount = 1;
  mono.channelCountMode = "explicit";
  const high = filter(ctx, "highpass", from);
  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = seconds;
  const left = gainNode(ctx, amount);
  const right = gainNode(ctx, -amount);
  const side = ctx.createChannelMerger(2);
  input.connect(dest);
  chain(input, mono, high, delay);
  chain(delay, left);
  chain(delay, right);
  left.connect(side, 0, 0);
  right.connect(side, 0, 1);
  side.connect(dest);
  return input;
}

/** Keep the mid as it is and high-pass the side, so the low end is mono. */
function monoLows(ctx: BaseAudioContext, from: AudioNode): AudioNode {
  const out = gainNode(ctx, 1);
  const mid = gainNode(ctx, 1);
  mid.channelCount = 1;
  mid.channelCountMode = "explicit"; // the downmix is (L + R) / 2
  chain(from, mid, out);
  const split = ctx.createChannelSplitter(2);
  const l = gainNode(ctx, 0.5);
  const r = gainNode(ctx, -0.5);
  from.connect(split);
  split.connect(l, 0);
  split.connect(r, 1);
  const side = filter(ctx, "highpass", 170);
  const side2 = filter(ctx, "highpass", 170);
  l.connect(side);
  r.connect(side);
  chain(side, side2);
  const plus = gainNode(ctx, 1);
  const minus = gainNode(ctx, -1);
  chain(side2, plus);
  chain(side2, minus);
  const merge = ctx.createChannelMerger(2);
  plus.connect(merge, 0, 0);
  minus.connect(merge, 0, 1);
  merge.connect(out);
  return out;
}

function hallReverb(ctx: BaseAudioContext, bank: SampleBank, id: string): ConvolverNode {
  const c = ctx.createConvolver();
  c.buffer = bank.get(id);
  return c;
}

const MASTER_LEVEL = 2.15; // into the ceiling
const STEM_LEVEL = 0.5;   // room for the parts to add up

/** Dub-style tape delay: filtered, driven repeats with a slow wow in the time. */
function tapeEcho(ctx: BaseAudioContext): { input: AudioNode; output: AudioNode; feedback: GainNode; time: AudioParam } {
  const input = gainNode(ctx, 1);
  const delay = ctx.createDelay(2);
  const low = filter(ctx, "highpass", 200);
  const high = filter(ctx, "lowpass", 4800);
  const warm = saturator(ctx, softClip(1.6));
  const unity = gainNode(ctx, 0.58); // the saturator adds gain; inside a feedback loop that would ring forever
  const feedback = gainNode(ctx, 0.38);
  const output = gainNode(ctx, 1);

  const wow = ctx.createOscillator();
  wow.frequency.value = 0.37;
  const wowDepth = gainNode(ctx, 0.0011);
  chain(wow, wowDepth);
  wowDepth.connect(delay.delayTime);
  wow.start();

  chain(input, delay, low, high, warm.input);
  chain(warm.node, unity, output);
  chain(unity, feedback, delay);
  return { input, output, feedback, time: delay.delayTime };
}

/**
 * `master: false` is for stems: they keep the master's tone, which is linear and so
 * still sums, and leave off its compression and ceiling, which don't.
 */
export function buildGraph(ctx: BaseAudioContext, bank: SampleBank, { master = true } = {}): Graph {
  /* master */
  const masterIn = gainNode(ctx, 1);
  const out = gainNode(ctx, OUTPUT_GAIN);
  const subsonic = filter(ctx, "highpass", 28);
  const lowTone = filter(ctx, "lowshelf", 70, 0.7, -2.8);
  const mids = filter(ctx, "peaking", 1100, 0.8, -1.5);
  const air = filter(ctx, "highshelf", 8500, 0.7, -11);
  chain(masterIn, subsonic);
  if (master) {
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -10;
    glue.ratio.value = 1.6;
    glue.attack.value = 0.03; // slow enough to let the kick's click through
    glue.release.value = 0.16;
    glue.knee.value = 10;
    const level = gainNode(ctx, MASTER_LEVEL * undoMakeup(-10, 1.6));
    const ceiling = saturator(ctx, ceilingCurve(), "4x");
    chain(monoLows(ctx, subsonic), lowTone, mids, air, glue, level, ceiling.input);
    ceiling.node.connect(out);
  } else {
    chain(monoLows(ctx, subsonic), lowTone, mids, air, gainNode(ctx, STEM_LEVEL), out);
  }
  out.connect(ctx.destination);

  /* ducked buses */
  const duckSynth = gainNode(ctx, 1);
  const duckBass = gainNode(ctx, 1);
  const duckRumble = gainNode(ctx, 1);
  const duckWet = gainNode(ctx, 1);
  for (const d of [duckSynth, duckBass, duckWet]) d.connect(masterIn);
  const lowGate = gainNode(ctx, 1);
  chain(duckRumble, lowGate, masterIn);

  /* channel strips */
  const strip = () => gainNode(ctx, 1);
  const strips = { lead: strip(), pad: strip(), stab: strip(), bass: strip(), rumble: strip(), perc: strip(), drums: strip(), fx: strip() };

  /* drums: the kick has its own chain, so the hats are never distorted by it */
  const kickIn = gainNode(ctx, 1);
  const kickHp = filter(ctx, "highpass", 30);
  const kickBox = filter(ctx, "peaking", 280, 1, -3);
  const kickWarm = saturator(ctx, softClip(0.9), "4x");
  chain(kickIn, kickHp, kickBox, kickWarm.input);
  chain(kickWarm.node, gainNode(ctx, 0.5), strips.drums);

  const drumsIn = gainNode(ctx, 1);
  const topsHp = filter(ctx, "highpass", 180);
  const tops = saturator(ctx, softClip(1.4));
  const drumsGain = gainNode(ctx, 1);
  chain(drumsIn, topsHp, tops.input);
  chain(tops.node, drumsGain, widener(ctx, 0.011, 0.3, strips.drums, 2000));
  strips.drums.connect(masterIn);

  const percIn = gainNode(ctx, 1);
  const percHp = filter(ctx, "highpass", 95);
  const percWarm = saturator(ctx, softClip(1.8));
  chain(percIn, percHp, percWarm.input);
  chain(percWarm.node, gainNode(ctx, 0.62), widener(ctx, 0.017, 0.4, strips.perc));
  strips.perc.connect(masterIn);

  /* rumble: reverb first, distortion after, then only the sub survives */
  const rumbleIn = gainNode(ctx, 1);
  const rumbleVerb = hallReverb(ctx, bank, "ir_hall");
  const rumbleDrive = saturator(ctx, softClip(1.9), "4x");
  const rumbleLp1 = filter(ctx, "lowpass", 210, 0.7);
  const rumbleLp2 = filter(ctx, "lowpass", 260, 0.7);
  const rumbleHp = filter(ctx, "highpass", 44);
  const rumbleMono = gainNode(ctx, 1);
  rumbleMono.channelCount = 1;
  rumbleMono.channelCountMode = "explicit";
  rumbleMono.channelInterpretation = "speakers";
  const rumbleGain = gainNode(ctx, 0.2);
  chain(rumbleIn, rumbleVerb, rumbleDrive.input);
  chain(rumbleDrive.node, rumbleLp1, rumbleLp2, rumbleHp, rumbleMono, strips.rumble, rumbleGain, duckRumble);

  /* bass: both layers share one gentle drive, so they read as one sound */
  const bassIn = gainNode(ctx, 1);
  const bassHp = filter(ctx, "highpass", 38);
  const bassDrive = saturator(ctx, softClip(1.3), "4x");
  chain(bassIn, bassHp, bassDrive.input);
  chain(bassDrive.node, gainNode(ctx, 0.5), strips.bass, duckBass);

  /* synth bus */
  const sweep = filter(ctx, "lowpass", 18000, 0.9);
  const synthBus = gainNode(ctx, 1);
  const synthHp = filter(ctx, "highpass", 150);
  const stabIn = gainNode(ctx, 1);
  const leadIn = gainNode(ctx, 1);
  const padIn = gainNode(ctx, 1);
  chain(stabIn, strips.stab, synthBus);
  chain(leadIn, strips.lead, synthBus);
  chain(padIn, strips.pad, synthBus);
  chain(synthBus, synthHp, sweep, widener(ctx, 0.021, 0.45, duckSynth));

  /* sends */
  const hallIn = gainNode(ctx, 1);
  const hallHp = filter(ctx, "highpass", 240);
  const hallLp = filter(ctx, "lowpass", 7000);
  const hallOut = gainNode(ctx, 0.5);
  chain(hallIn, hallHp, hallLp, hallReverb(ctx, bank, "ir_hall"), hallOut, duckWet);

  const roomIn = gainNode(ctx, 1);
  const roomHp = filter(ctx, "highpass", 320);
  chain(roomIn, roomHp, hallReverb(ctx, bank, "ir_room"), gainNode(ctx, 0.7), masterIn);

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

  const atmos = gainNode(ctx, 0.08);
  chain(atmos, filter(ctx, "highpass", 300), strips.fx);

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
    drive: tops.node,
    drumsGain,
    rumbleGain,
    lowGate,
    atmos,
    out,
    state: { acidCutoff: 1, brightness: 0.5 },
  };
}

/** Switch a channel and its sends on or off. */
/** A part's level in dB, from its fader. Sends follow it, so the space keeps its balance. */
export function setChannel(g: Graph, id: ChannelId, on: boolean, time?: number, db = 0): void {
  const level = on ? 10 ** (db / 20) : 0;
  const nodes = [g.strips[id], g.gates[id].hall, g.gates[id].echo, g.gates[id].room];
  for (const n of nodes) {
    if (time == null) n.gain.value = level;
    else n.gain.setTargetAtTime(level, time, 0.01);
  }
}

/** Apply the mix derived from the controls. Works before and during playback. */
export function applyMix(g: Graph, mix: MixParams, beatSec: number, time = 0): void {
  g.echoTime.setValueAtTime(beatSec * 0.75, time); // dotted eighth, locked to the tempo
  const amount = 1 + mix.drive * 1.6;
  g.drive.curve = softClip(amount);
  // small signals gain k / tanh(k), so take some of it back
  g.drumsGain.gain.setValueAtTime(1 / Math.sqrt(amount / Math.tanh(amount)), time);
  g.rumbleGain.gain.setValueAtTime(0.05 + mix.rumble * 0.17, time);
  g.hallOut.gain.setValueAtTime(0.2 + mix.space * 0.65, time);
  g.echoFb.gain.setValueAtTime(0.25 + mix.echo * 0.34, time);
  g.lowGate.gain.setValueAtTime(1, time); // open, unless the arrangement says otherwise
  g.state.brightness = mix.brightness;
}
