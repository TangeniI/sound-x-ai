/**
 * lib/audio/voices.ts
 *
 * Turns note events into sample playback. Every voice is a recording repitched
 * through a real filter and envelope. Used unchanged by the live player and the
 * offline bounce.
 */

import type { Automation, NoteEvent, Track } from "../../types";
import { softClip, type ChannelId, type Graph } from "./graph";
import type { SampleBank } from "./samples";
import { hitNoise, PERC } from "../writing";
import { chordOf, pickZone, SUB, TOM_ROOT, type Kit } from "./kits";

/** Everything a voice needs. Live and offline each build their own. */
export interface Runtime {
  ctx:   BaseAudioContext;
  graph: Graph;
  bank:  SampleBank;
  kit:   Kit;
  track: Track;
  /** live only: tracked so stop() can silence what is already scheduled */
  active?: Set<AudioBufferSourceNode>;
  openHat?: GainNode;
  lastBassRate?: number;
}

export function makeRuntime(ctx: BaseAudioContext, graph: Graph, bank: SampleBank, track: Track, active?: Set<AudioBufferSourceNode>): Runtime {
  return { ctx, graph, bank, track, kit: track.kit, active };
}

interface HitOptions {
  gain?:    number;
  rate?:    number;
  dur?:     number;     // gate the sample after this long
  release?: number;
  attack?:  number;
  offset?:  number;
  pan?:     number;
  sends?:   [number, number]; // hall, echo
  room?:    number;
  tone?:    number;        // Hz, a low-pass for this hit only
  lane?:    ChannelId;        // whose sends these are
}

/** Play a buffer into `dest`. Returns the gain so a voice can reshape it. */
function hit(rt: Runtime, buffer: AudioBuffer, dest: AudioNode, time: number, o: HitOptions = {}): { src: AudioBufferSourceNode; amp: GainNode } {
  const { ctx } = rt;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = o.rate ?? 1;
  const amp = ctx.createGain();
  const level = o.gain ?? 1;
  const release = o.release ?? 0.012;
  if (o.attack) {
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(level, time + o.attack);
  } else {
    amp.gain.value = level;
  }
  let tail: AudioNode = src;
  if (o.tone && o.tone < ctx.sampleRate / 2) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.Q.value = 0.6;
    f.frequency.value = o.tone;
    tail.connect(f);
    tail = f;
  }
  tail.connect(amp);
  tail = amp;
  if (o.pan) {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    tail.connect(p);
    tail = p;
  }
  tail.connect(dest);
  const gates = rt.graph.gates[o.lane ?? "drums"];
  if (o.sends) {
    if (o.sends[0] > 0) sendTo(rt, tail, gates.hall, o.sends[0]);
    if (o.sends[1] > 0) sendTo(rt, tail, gates.echo, o.sends[1]);
  }
  if (o.room) sendTo(rt, tail, gates.room, o.room);

  src.start(time, o.offset ?? 0);
  if (o.dur != null) {
    const end = time + o.dur;
    amp.gain.setValueAtTime(level, Math.max(time + (o.attack ?? 0), end));
    amp.gain.linearRampToValueAtTime(0.0001, end + release);
    src.stop(end + release + 0.01);
  }
  if (rt.active) {
    rt.active.add(src);
    src.onended = () => rt.active?.delete(src);
  }
  return { src, amp };
}

function sendTo(rt: Runtime, from: AudioNode, to: AudioNode, amount: number): void {
  const g = rt.ctx.createGain();
  g.gain.value = amount;
  from.connect(g);
  g.connect(to);
}

const curve = (velocity: number) => (velocity / 127) ** 1.6;

/**
 * No two hits on a machine or a drum are the same, and one recording repeated
 * exactly is what makes a sampler sound like one. Each hit gets its own tuning,
 * brightness and start point, fixed by its place in the track.
 */
function wobble(rt: Runtime, n: NoteEvent, salt: number): number {
  return hitNoise(rt.track.config.seed, n.step, n.pitch * 8 + salt) * 2 - 1;
}

/* ─────────────────────────── drums + percussion ──────────────────────── */

function pump(rt: Runtime, time: number): void {
  const { graph, track } = rt;
  const depth = track.mix.pump;
  const beat = track.stepSec * 4;
  const [synth, low, rumble, wet] = graph.ducks;
  // targets rather than ramps: a second kick inside the release can't cause a jump
  const duck = (g: GainNode, floor: number, hold: number, back: number) => {
    g.gain.setTargetAtTime(floor, time, 0.004);
    g.gain.setTargetAtTime(1, time + beat * hold, beat * back);
  };
  duck(synth, 1 - depth * 0.62, 0.1, 0.12);
  duck(low, 1 - depth * 0.92, 0.18, 0.09);
  duck(wet, 1 - depth * 0.5, 0.1, 0.14);
  // the rumble clears out for the kick, then swells back up to meet the next one
  duck(rumble, 0.03, 0.3, 0.17);
}

function drum(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit, track } = rt;
  const v = curve(n.velocity);
  const [a, b] = [wobble(rt, n, 0), wobble(rt, n, 1)];
  const input = graph.inputs.drums;
  const tops = kit.tops ?? 1;
  switch (n.pitch) {
    case 35:
      hit(rt, bank.get(kit.kick), graph.kickIn, time, { gain: 0.8 * v, rate: 2 ** (track.mix.kickTune / 12), tone: 220, dur: 0.07, release: 0.03 });
      break;
    case 36: {
      const rate = 2 ** (track.mix.kickTune / 12);
      hit(rt, bank.get(kit.kick), graph.kickIn, time, { gain: 1.35 * kit.kickGain * v, rate, dur: kit.kickLen, release: 0.05 });
      if (kit.slam) {
        // band-limited, so it adds the sound of the space without touching the sub
        const band = bandPass(rt, graph.inputs.drums, time, 260, 1300);
        hit(rt, bank.get("impact"), band, time, { gain: kit.slam * v, rate: 1.3 + a * 0.03, dur: 0.05, release: 0.04, room: 0.5 });
      }
      hit(rt, bank.get("kick_808_long"), graph.inputs.rumble, time, {
        // the reverb smears a repeat into one held note unless each hit moves a little
        gain: 0.9, rate: 2 ** ((track.mix.rumbleTune + a * 0.7) / 12), offset: (b + 1) * 0.01,
      });
      pump(rt, time);
      break;
    }
    case 37:
      hit(rt, bank.get(kit.rim), input, time, { gain: 0.7 * v, rate: 1 + a * 0.02, pan: 0.12 + b * 0.05, room: 0.45, sends: [0.06, 0.12] });
      break;
    case 38:
    case 40: {
      // 40 is the same drum in a roll: lighter, so the build doesn't swamp the hit
      const level = (kit.snareGain ?? 1) * v * (n.pitch === 40 ? 0.6 : 1);
      (kit.snare ?? [{ id: kit.clap[0], gain: 0.95 }]).forEach((layer, i) => {
        const dest = layer.hp ? bandPass(rt, input, time, layer.hp, 14000) : input;
        hit(rt, bank.get(layer.id), dest, time + (layer.delay ?? 0), {
          gain: layer.gain * level, rate: (layer.rate ?? 1) * (1 + (i % 2 ? b : a) * 0.015), dur: layer.len, release: 0.025,
          pan: i ? b * 0.14 : 0, room: n.pitch === 40 ? 0.2 : 0.4, sends: i === 0 ? [0.12, 0] : undefined,
        });
      });
      break;
    }
    case 39:
      hit(rt, bank.get(kit.clap[0]), input, time, { gain: 0.95 * v, rate: 1 + a * 0.015, room: 0.45, sends: [0.12, 0] });
      hit(rt, bank.get(kit.clap[1]), input, time + 0.004 + (b + 1) * 0.003, { gain: 0.38 * v, rate: 1 + b * 0.03, pan: b * 0.25, room: 0.3 });
      break;
    case 42: {
      if (rt.openHat) {
        rt.openHat.gain.cancelScheduledValues(time);
        rt.openHat.gain.setTargetAtTime(0, time, 0.008);
        rt.openHat = undefined;
      }
      const pan = (n.step % 2 ? -0.18 : 0.12) + b * 0.08;
      const tone = 4800 + v * 15000;
      const dur = 0.035 + v * 0.1 + (b + 1) * 0.01;
      hit(rt, bank.get(kit.hatC[0]), input, time, { gain: 0.7 * v * tops, rate: 1 + a * 0.025, offset: (a + 1) * 0.0008, tone, pan, room: 0.1, dur, release: 0.03 });
      // the second hat only speaks on the harder hits
      if (v > 0.22) hit(rt, bank.get(kit.hatC[1]), input, time, { gain: 0.42 * v * v * tops, rate: 1 + b * 0.03, pan: -pan * 1.5, dur: 0.06, release: 0.03 });
      break;
    }
    case 46: {
      const h = hit(rt, bank.get(kit.hatO), input, time, { gain: 0.82 * v * tops, rate: 1 + a * 0.02, tone: 9000 + v * 10000, pan: 0.2 + b * 0.08, room: 0.16 });
      rt.openHat = h.amp;
      break;
    }
    case 49: hit(rt, bank.get("crash_909"), input, time, { gain: 0.3 * v, room: 0.3, sends: [0.4, 0] }); break;
    case 51:
      hit(rt, bank.get("ride_909"), input, time, { gain: 0.42 * v * tops, rate: 1 + a * 0.012, offset: (b + 1) * 0.001, tone: 6000 + v * 13000, pan: -0.32, room: 0.14, dur: 0.22 + v * 0.3, release: 0.14 });
      break;
  }
}

function perc(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit, track } = rt;
  const v = curve(n.velocity);
  const [a, b] = [wobble(rt, n, 0), wobble(rt, n, 1)];
  const [hall, echo] = kit.sends.perc;
  const dest = graph.inputs.perc;
  const trim = kit.trim?.perc ?? 1;
  const tom = (PERC.toms as readonly number[]).indexOf(n.pitch);
  if (tom >= 0) {
    // root, fifth and octave, from the nearest tonic below the recording
    const base = 43 + ((track.root - 43) % 12 + 12) % 12;
    const target = base + [0, 7, 7][tom] + a * 0.25;
    hit(rt, bank.get("tom_808"), dest, time, {
      gain: 0.55 * v * trim, rate: 2 ** ((target - TOM_ROOT) / 12), tone: 500 + v * 1700, dur: 0.03 + v * 0.07, release: 0.045,
      pan: [0, -0.3, 0.3][tom] + b * 0.1, sends: [hall * 0.6, echo * 0.3], room: 0.4, lane: "perc",
    });
  } else if (n.pitch === PERC.shaker) {
    hit(rt, bank.get("shaker"), dest, time, {
      gain: 1.5 * v * (kit.tops ?? 1), rate: 1 + a * 0.06, offset: (b + 1) * 0.003, tone: 6000 + v * 14000,
      pan: 0.45 + b * 0.12, room: 0.12, lane: "perc",
    });
  } else {
    const second = n.pitch === PERC.hitB;
    // the echo is thrown on some hits rather than poured over all of them
    const thrown = b > 0.4 ? echo * 2 : echo * 0.3;
    hit(rt, bank.get(kit.perc[second ? 1 : 0]), dest, time, {
      gain: 1.1 * v * trim, dur: kit.percLen, release: 0.05, rate: (second ? 0.89 : 1) * (1 + a * 0.08), tone: kit.percTone * (0.5 + v),
      pan: (second ? 0.38 : -0.38) + b * 0.1, sends: [hall, thrown], room: 0.35, lane: "perc",
    });
  }
}

/* ──────────────────────────────── bass ───────────────────────────────── */

function bandPass(rt: Runtime, dest: AudioNode, time: number, from: number, to: number): BiquadFilterNode {
  const high = rt.ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.setValueAtTime(from, time);
  const low = rt.ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.setValueAtTime(to, time);
  high.connect(low);
  low.connect(dest);
  return high;
}

/** A gain that falls away like a struck drum, instead of holding like a key. */
function decaying(rt: Runtime, dest: AudioNode, time: number, seconds: number, after = 0.02): GainNode {
  const g = rt.ctx.createGain();
  g.gain.setValueAtTime(1, time);
  g.gain.setTargetAtTime(0, time + after, seconds);
  g.connect(dest);
  return g;
}

// one oscillator driven square, as in a 303, with nothing detuned against it
const SQUARE = softClip(5, 1);

function bass(rt: Runtime, n: NoteEvent, time: number): void {
  const { ctx, graph, bank, kit } = rt;
  const voice = kit.bass;
  const dur = Math.max(0.05, n.endTime - n.startTime);
  const [a, b] = [wobble(rt, n, 0), wobble(rt, n, 1)];
  const v = curve(n.velocity);
  const rate = 2 ** ((n.pitch + a * 0.03 - SUB.root) / 12);
  const input = graph.inputs.bass;

  let dest: AudioNode;
  if (voice.acid) {
    const { cutoff, sweep, q } = voice.acid;
    const open = graph.state.acidCutoff;
    const rest = cutoff * (0.7 + open * 0.8);
    const peak = rest + sweep * open * (n.accent ? 1.5 : 0.8) * (0.6 + v * 0.5) * (1 + b * 0.18);
    const out = decaying(rt, input, time, n.accent ? voice.decay * 1.3 : voice.decay);
    out.gain.setValueAtTime(0.5, time);
    const first = filtered(rt, out, time, peak, rest, n.accent ? 0.08 : 0.14, 1.2);
    const second = filtered(rt, first, time, peak, rest, n.accent ? 0.08 : 0.14, q);
    const square = ctx.createWaveShaper();
    square.curve = SQUARE;
    square.oversample = "2x";
    square.connect(second);
    dest = square;
  } else {
    // only the fundamental: anything higher in this layer reads as a synth
    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 120 + v * 50;
    low.connect(decaying(rt, input, time, voice.decay * (0.85 + (b + 1) * 0.15)));
    dest = low;
  }

  const { src } = hit(rt, bank.get(SUB.id), dest, time, {
    gain: voice.sub * v * Math.min(1, kit.trim?.bass ?? 1), rate, offset: SUB.offset, attack: 0.006, dur, release: 0.035,
  });
  if (n.slide && rt.lastBassRate) {
    src.playbackRate.setValueAtTime(rt.lastBassRate, time);
    src.playbackRate.exponentialRampToValueAtTime(rate, time + 0.07);
  }
  rt.lastBassRate = rate;

  if (voice.body) {
    // the knock is a drum, so it keeps its own pitch whatever the key
    const { id, gain, tone, rate: speed } = voice.body;
    const band = bandPass(rt, input, time, 100, tone * (0.7 + v * 0.6) * (1 + b * 0.15));
    hit(rt, bank.get(id), decaying(rt, band, time, 0.035), time, { gain: gain * v * (kit.trim?.bass ?? 1), rate: speed * (1 + a * 0.03), dur: 0.11, release: 0.03 });
  }
}

/* ──────────────────────────── stabs + texture ────────────────────────── */

function filtered(rt: Runtime, dest: AudioNode, time: number, peak: number, rest: number, decay: number, q = 0.9): BiquadFilterNode {
  const f = rt.ctx.createBiquadFilter();
  f.type = "lowpass";
  f.Q.value = q;
  f.frequency.setValueAtTime(peak, time);
  f.frequency.exponentialRampToValueAtTime(rest, time + decay);
  f.connect(dest);
  return f;
}

function stab(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit } = rt;
  const dur = Math.max(0.08, n.endTime - n.startTime);
  const bright = graph.state.brightness;
  const v = curve(n.velocity);
  const open = (1 + wobble(rt, n, 0) * 0.1) * (0.8 + v * 0.3);
  const peak = kit.stab ? kit.stab.open * (0.6 + bright * 0.8) : 700 + bright * 1300;
  const rest = kit.stab ? kit.stab.rest * (0.7 + bright * 0.6) : 240 + bright * 260;
  const f = filtered(rt, graph.inputs.stab, time, peak * open, rest * open, Math.min(0.2, dur), 0.8);
  const body = decaying(rt, f, time, dur * 0.4);
  const offsets = n.chord ?? [0];
  const instrument = chordOf(kit);
  for (const off of offsets) {
    const z = pickZone(instrument.zones, n.pitch + off);
    hit(rt, bank.get(z.id), body, time, { gain: (0.42 * v * instrument.gain * (kit.trim?.stab ?? 1)) / Math.sqrt(offsets.length), rate: z.rate, dur, release: 0.12, attack: 0.004, lane: "stab" });
  }
  // the echo hears the darkened, decayed stab, not the raw sample
  const [hall, echo] = kit.sends.stab;
  sendTo(rt, f, graph.gates.stab.hall, hall);
  sendTo(rt, f, graph.gates.stab.echo, echo);
}

// recording, speed, where to start, level
const TEXTURES = [
  ["gong", 0.5, 0.8, 0.14],
  ["gong_scrape", 0.5, 0.2, 0.2],
  ["fx_bed", 0.75, 0.5, 0.2],
  ["gong", 0.33, 1.2, 0.17],
  ["cymbal_808_long", 0.4, 0.3, 0.18],
] as const;

/** Slow metal and air from real recordings, with no chord to clash. */
function pad(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit } = rt;
  const dur = n.endTime - n.startTime;
  const v = curve(n.velocity);
  if (kit.texture && n.variant == null) {
    // the same slice for the same 16th, so it repeats like a loop
    const { id, rate, offset, from, to, gain } = kit.texture;
    const answer = n.pitch > 59 ? 1.25 : 1;
    const band = bandPass(rt, graph.inputs.pad, time, from, to * answer * (0.7 + graph.state.brightness * 0.6));
    const body = decaying(rt, band, time, dur * (n.accent ? 0.6 : 0.4));
    hit(rt, bank.get(id), body, time, {
      gain: gain * v * (kit.trim?.pad ?? 1), rate: rate * answer, offset: offset + (n.step % 4) * 0.025,
      attack: 0.002, dur, release: 0.03, pan: wobble(rt, n, 1) * 0.2, sends: [0.14, 0.05], lane: "pad",
    });
    return;
  }
  const f = bandPass(rt, graph.inputs.pad, time, 220, 600 + graph.state.brightness * 900);
  // each rewrite picks another recording and stretch of it
  const [id, speed, offset, level] = TEXTURES[(n.variant ?? 0) % TEXTURES.length];
  const rate = speed * (1 + wobble(rt, n, 0) * 0.03);
  const buffer = bank.get(id);
  const usable = buffer.duration / rate;
  const fade = Math.min(1, dur * 0.3);
  // start past the strike, and overlap like a tape loop
  const span = Math.max(0.5, usable - offset / rate - fade * 2);
  for (let t = 0; t < dur; t += span) {
    const body = Math.max(0.05, Math.min(span, dur - t));
    hit(rt, buffer, f, time + t, { gain: level * v, rate, offset, attack: fade, dur: fade + body, release: fade, sends: [0.4, 0.05], lane: "pad" });
  }
}

function lead(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit } = rt;
  const voice = kit.lead;
  const dur = Math.max(0.06, n.endTime - n.startTime);
  const z = pickZone(voice.zones, n.pitch);
  const bright = graph.state.brightness;
  const rest = voice.cutoff * (0.5 + bright * 0.7);
  const open = 1 + wobble(rt, n, 0) * 0.3;
  const level = voice.gain * curve(n.velocity) * (kit.trim?.lead ?? 1);
  if (voice.acid) {
    const { sweep, q } = voice.acid;
    const peak = rest + sweep * (n.accent ? 1 : 0.45) * open;
    const out = decaying(rt, graph.inputs.lead, time, dur * 0.8);
    out.gain.setValueAtTime(level, time);
    const second = filtered(rt, out, time, peak, rest * 0.6, voice.decay, q);
    const first = filtered(rt, second, time, peak, rest * 0.6, voice.decay, 1);
    const square = rt.ctx.createWaveShaper();
    square.curve = SQUARE;
    square.oversample = "2x";
    square.connect(first);
    // full level into the shaper, or it wouldn't square
    hit(rt, bank.get(SUB.id), square, time, { rate: 2 ** ((n.pitch - SUB.root) / 12), offset: SUB.offset, attack: 0.003, dur, release: 0.03 });
    sendTo(rt, out, graph.gates.lead.hall, kit.sends.lead[0]);
    sendTo(rt, out, graph.gates.lead.echo, kit.sends.lead[1]);
    return;
  }
  const f = filtered(rt, graph.inputs.lead, time, rest * 3 * open, rest * open, voice.decay, 2.5);
  hit(rt, bank.get(z.id), f, time, {
    gain: level,
    rate: z.rate,
    dur,
    release: 0.08,
    pan: wobble(rt, n, 1) * 0.3,
    sends: kit.sends.lead,
    lane: "lead",
  });
}

/* ───────────────────────────── transitions ───────────────────────────── */

function fx(rt: Runtime, n: NoteEvent, time: number): void {
  const { ctx, graph, bank } = rt;
  const dur = n.endTime - n.startTime;
  const out = graph.inputs.fx;
  if (n.pitch === 1) {
    // risers are real cymbals and a scraped gong, played backwards into the drop
    for (const [id, level] of [["gong_scrape", 0.22], ["cymbal_808_long", 0.22]] as const) {
      const buffer = bank.reversed(ctx, id);
      const length = Math.min(dur, buffer.duration);
      hit(rt, buffer, out, time + dur - length, { gain: level, offset: buffer.duration - length, attack: length * 0.5, sends: [0.4, 0], lane: "fx" });
    }
  } else if (n.pitch === 2) {
    hit(rt, bank.get("impact"), out, time, { gain: 0.3, sends: [0.4, 0], lane: "fx" });
  } else if (n.pitch === 4) {
    // air drawn in ahead of a phrase's hit
    const buffer = bank.reversed(ctx, "cymbal_808_long");
    const length = Math.min(dur, buffer.duration);
    hit(rt, buffer, out, time + dur - length, { gain: 0.15, offset: buffer.duration - length, attack: length * 0.7, dur: length, release: 0.01, lane: "fx" });
  } else if (n.pitch === 3) {
    const buffer = bank.get("fx_bed");
    for (let t = 0; t < dur; t += buffer.duration - 1) {
      const body = Math.min(buffer.duration - 2, dur - t);
      hit(rt, buffer, out, time + t, { gain: 0.1, tone: 1800, attack: 1, dur: 1 + body, release: 1, sends: [0.3, 0], lane: "fx" });
    }
  }
}

export function trigger(rt: Runtime, n: NoteEvent, time: number): void {
  // set on every note, so a seek or a loop back always lands on the right sounds
  const { kit, endKit } = rt.track;
  rt.kit = endKit && n.step >= endKit.from ? endKit.kit : kit;
  switch (n.instrument) {
    case "drums": drum(rt, n, time); break;
    case "perc": perc(rt, n, time); break;
    case "bass": bass(rt, n, time); break;
    case "stab": stab(rt, n, time); break;
    case "pad": pad(rt, n, time); break;
    case "lead": lead(rt, n, time); break;
    case "fx": fx(rt, n, time); break;
  }
}

/** Apply one arrangement move at audio time `time`. */
export function automate(rt: Runtime, a: Automation, time: number): void {
  rampFrom(rt.graph, a, a.from, time, a.ramp);
}

/** Pick a move up part-way through, after a seek or a swapped track. */
export function resumeAutomation(graph: Graph, a: Automation, pos: number, time: number): void {
  const left = a.time + a.ramp - pos;
  if (left <= 0) {
    rampFrom(graph, a, a.value, time, 0);
    return;
  }
  const done = (pos - a.time) / a.ramp;
  const now = a.param === "cutoff" ? a.from * (a.value / a.from) ** done : a.from + (a.value - a.from) * done;
  rampFrom(graph, a, now, time, left);
}

/** Every move states its start, so it never ramps from whatever came before it. */
function rampFrom(graph: Graph, a: Automation, from: number, time: number, seconds: number): void {
  if (a.param === "acid") {
    graph.state.acidCutoff = a.value;
    return;
  }
  const param = a.param === "cutoff" ? graph.sweep.frequency
    : a.param === "space" ? graph.hallOut.gain
    : a.param === "low" ? graph.lowGate.gain
    : graph.echoFb.gain;
  if (seconds <= 0) {
    param.setValueAtTime(a.value, time);
    return;
  }
  param.setValueAtTime(from, time);
  if (a.param === "cutoff") param.exponentialRampToValueAtTime(a.value, time + seconds);
  else param.linearRampToValueAtTime(a.value, time + seconds);
}

/** Keep the noise floor of a record under everything. */
export function startAtmosphere(rt: Runtime, time: number, seconds?: number): AudioBufferSourceNode {
  const src = rt.ctx.createBufferSource();
  src.buffer = rt.bank.get("vinyl");
  src.loop = true;
  src.connect(rt.graph.atmos);
  src.start(time);
  if (seconds != null) src.stop(time + seconds);
  return src;
}
