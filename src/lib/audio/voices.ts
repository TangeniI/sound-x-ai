/**
 * lib/audio/voices.ts
 *
 * Turns note events into sample playback. Every voice is a recording repitched
 * through a real filter and envelope. Used unchanged by the live player and the
 * offline bounce.
 */

import type { Automation, NoteEvent, Track } from "../../types";
import type { ChannelId, Graph } from "./graph";
import type { SampleBank } from "./samples";
import { chordRate, FM, KITS, pickZone, type Kit } from "./kits";

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
  panFlip: boolean;
}

export function makeRuntime(ctx: BaseAudioContext, graph: Graph, bank: SampleBank, track: Track, active?: Set<AudioBufferSourceNode>): Runtime {
  return { ctx, graph, bank, track, kit: KITS[track.config.style], active, panFlip: false };
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

/* ─────────────────────────── drums + percussion ──────────────────────── */

function pump(rt: Runtime, time: number): void {
  const { graph, track } = rt;
  const depth = track.mix.pump;
  const beat = (track.stepSec * 4);
  const [synth, low, rumble, wet] = graph.ducks;
  const duck = (g: GainNode, floor: number, hold: number, back: number) => {
    g.gain.setValueAtTime(1, time);
    g.gain.linearRampToValueAtTime(floor, time + 0.006);
    g.gain.setValueAtTime(floor, time + beat * hold);
    g.gain.linearRampToValueAtTime(1, time + beat * back);
  };
  duck(synth, 1 - depth * 0.62, 0.04, 0.6);
  duck(low, 1 - depth * 0.86, 0.1, 0.62);
  duck(wet, 1 - depth * 0.45, 0.04, 0.6);
  // the rumble clears out for the kick, then swells back up to meet the next one
  duck(rumble, 0.05, 0.24, 0.96);
}

function drum(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit, track } = rt;
  const v = curve(n.velocity);
  const input = graph.inputs.drums;
  switch (n.pitch) {
    case 36: {
      const rate = 2 ** (track.mix.kickTune / 12);
      hit(rt, bank.get(kit.kick), graph.kickIn, time, { gain: 1.2 * v, rate, dur: kit.kickLen, release: 0.03 });
      hit(rt, bank.get("kick_808_long"), graph.inputs.rumble, time, { gain: 0.9, rate: 2 ** (track.mix.rumbleTune / 12) });
      pump(rt, time);
      break;
    }
    case 37: hit(rt, bank.get(kit.rim), input, time, { gain: 0.36 * v, room: 0.3 }); break;
    case 39: hit(rt, bank.get(kit.clap), input, time, { gain: 0.72 * v, room: 0.42, sends: [0.12, 0] }); break;
    case 42:
      if (rt.openHat) {
        rt.openHat.gain.cancelScheduledValues(time);
        rt.openHat.gain.setTargetAtTime(0, time, 0.008);
        rt.openHat = undefined;
      }
      hit(rt, bank.get(kit.hatC), input, time, { gain: 0.62 * v, room: 0.08, dur: Math.min(0.18, n.endTime - n.startTime + 0.08), release: 0.03 });
      break;
    case 46: {
      const h = hit(rt, bank.get(kit.hatO), input, time, { gain: 0.62 * v, room: 0.18 });
      rt.openHat = h.amp;
      break;
    }
    case 49: hit(rt, bank.get("crash_909"), input, time, { gain: 0.34 * v, room: 0.3, sends: [0.25, 0] }); break;
    case 51: hit(rt, bank.get(kit.ride), input, time, { gain: 0.34 * v, room: 0.12, dur: 0.5, release: 0.14 }); break;
  }
}

function perc(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit } = rt;
  const slot = n.pitch === 56 ? 0 : n.pitch === 60 ? 1 : 2;
  const [hall, echo] = kit.sends.perc;
  rt.panFlip = !rt.panFlip;
  hit(rt, bank.get(kit.perc[slot]), graph.inputs.perc, time, {
    gain: kit.percGain * curve(n.velocity),
    pan: (rt.panFlip ? 1 : -1) * (0.12 + slot * 0.12),
    sends: [hall, echo],
    room: 0.3,
    lane: "perc",
  });
}

/* ──────────────────────────────── bass ───────────────────────────────── */

function bass(rt: Runtime, n: NoteEvent, time: number): void {
  const { ctx, graph, bank, kit } = rt;
  const voice = kit.bass;
  const dur = Math.max(0.05, n.endTime - n.startTime);
  const rate = 2 ** ((n.pitch - 36) / 12);
  const accent = voice.acid && n.accent;
  const level = (accent ? 0.86 : 0.64) * curve(n.velocity);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = accent ? voice.q * 1.35 : voice.q;
  let tail: AudioNode = lp;
  if (voice.acid) {
    // two filters in series get close to the 303's 24 dB slope
    const lp2 = ctx.createBiquadFilter();
    lp2.type = "lowpass";
    lp2.Q.value = 1.2;
    lp.connect(lp2);
    tail = lp2;
  }
  tail.connect(graph.inputs.bass);

  const open = graph.state.acidCutoff;
  const rest = voice.cutoff * (voice.acid ? 0.6 + open * 0.8 : 1);
  const peak = rest + voice.sweep * (voice.acid ? open : 1) * (accent ? 1.5 : 1) * (0.55 + curve(n.velocity) * 0.6);
  const decay = accent ? voice.decay * 0.6 : voice.decay;
  const targets = tail === lp ? [lp] : [lp, tail as BiquadFilterNode];
  for (const f of targets) {
    f.frequency.setValueAtTime(peak, time);
    f.frequency.exponentialRampToValueAtTime(Math.max(50, rest), time + decay);
  }

  const { src } = hit(rt, bank.get(voice.id), lp, time, { gain: level, rate, dur, release: 0.02, attack: 0.002 });
  if (n.slide && rt.lastBassRate) {
    src.playbackRate.setValueAtTime(rt.lastBassRate, time);
    src.playbackRate.exponentialRampToValueAtTime(rate, time + 0.07);
  }
  rt.lastBassRate = rate;
}

/* ──────────────────────────── stabs + chords ─────────────────────────── */

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
  const { graph, bank, kit, track } = rt;
  const dur = Math.max(0.08, n.endTime - n.startTime);
  const bright = graph.state.brightness;
  const f = filtered(rt, graph.inputs.stab, time, 1400 + bright * 5200, 500 + bright * 1100, Math.min(0.5, dur + 0.1));
  const sends = kit.sends.stab;
  const v = curve(n.velocity);
  const useSample = kit.chord && track.tonality === "minor";

  if (useSample) {
    const zone = kit.chord!;
    hit(rt, bank.get(zone.id), f, time, { gain: 1.25 * v, rate: chordRate(zone, n.pitch), dur, release: 0.07, sends, lane: "stab" });
    return;
  }
  const offsets = n.chord ?? [0];
  offsets.forEach((off, i) => {
    const z = pickZone(FM, n.pitch + off);
    const pan = offsets.length > 1 ? (i / (offsets.length - 1) - 0.5) * 0.6 : 0;
    hit(rt, bank.get(z.id), f, time, { gain: (0.62 * v) / Math.sqrt(offsets.length), rate: z.rate, dur, release: 0.12, pan, sends, lane: "stab" });
  });
}

function pad(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit, track } = rt;
  const dur = n.endTime - n.startTime;
  const v = curve(n.velocity);
  const f = rt.ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 900 + graph.state.brightness * 2600;
  f.connect(graph.inputs.pad);

  if (track.tonality === "major") {
    const offsets = n.chord ?? [0];
    offsets.forEach((off, i) => {
      const z = pickZone(FM, n.pitch + off);
      const pan = (i / Math.max(1, offsets.length - 1) - 0.5) * 0.7;
      hit(rt, bank.get(z.id), f, time, { gain: (0.42 * v) / Math.sqrt(offsets.length), rate: z.rate, attack: 0.05, dur, release: 0.5, pan, sends: [0.5, 0.1], lane: "pad" });
    });
    return;
  }

  // the recordings are shorter than a phrase, so overlap them like a tape loop
  const rate = chordRate(kit.pad, n.pitch);
  const buffer = bank.get(kit.pad.id);
  const usable = buffer.duration / rate;
  const fade = Math.min(0.6, usable * 0.28);
  const hop = usable - fade * 1.4;
  for (let t = 0; t < dur; t += hop) {
    const body = Math.max(0.05, Math.min(usable - fade * 2, dur - t));
    hit(rt, buffer, f, time + t, { gain: 0.56 * v, rate, attack: fade, dur: fade + body, release: fade, sends: [0.55, 0.08], lane: "pad" });
  }
}

function lead(rt: Runtime, n: NoteEvent, time: number): void {
  const { graph, bank, kit } = rt;
  const voice = kit.lead;
  const dur = Math.max(0.06, n.endTime - n.startTime);
  const z = pickZone(voice.zones, n.pitch);
  const bright = graph.state.brightness;
  const rest = voice.cutoff * (0.5 + bright * 0.7);
  const f = filtered(rt, graph.inputs.lead, time, rest * 2.4, rest, voice.decay);
  rt.panFlip = !rt.panFlip;
  hit(rt, bank.get(z.id), f, time, {
    gain: voice.gain * curve(n.velocity),
    rate: z.rate,
    dur,
    release: 0.08,
    pan: rt.panFlip ? 0.14 : -0.14,
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
    for (const [id, level] of [["gong_scrape", 0.5], ["cymbal_808_long", 0.34]] as const) {
      const buffer = bank.reversed(ctx, id);
      const length = Math.min(dur, buffer.duration);
      hit(rt, buffer, out, time + dur - length, { gain: level, offset: buffer.duration - length, attack: length * 0.5, sends: [0.4, 0], lane: "fx" });
    }
  } else if (n.pitch === 2) {
    hit(rt, bank.get("gong"), out, time, { gain: 0.34, sends: [0.5, 0], dur: 3.4, release: 1.2, lane: "fx" });
    hit(rt, bank.get("boom"), out, time, { gain: 0.5 });
    hit(rt, bank.get("crash_909"), out, time, { gain: 0.32 });
  } else if (n.pitch === 3) {
    const buffer = bank.get("fx_bed");
    for (let t = 0; t < dur; t += buffer.duration - 1) {
      const body = Math.min(buffer.duration - 2, dur - t);
      hit(rt, buffer, out, time + t, { gain: 0.34, attack: 1, dur: 1 + body, release: 1, sends: [0.3, 0], lane: "fx" });
    }
  }
}

export function trigger(rt: Runtime, n: NoteEvent, time: number): void {
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
  const { graph } = rt;
  const end = time + Math.max(0.001, a.ramp);
  if (a.param === "cutoff") {
    const f = graph.sweep.frequency;
    f.setValueAtTime(Math.max(40, f.value), time);
    f.exponentialRampToValueAtTime(a.value, end);
  } else if (a.param === "space") {
    graph.hallOut.gain.linearRampToValueAtTime(a.value, end);
  } else if (a.param === "echo") {
    graph.echoFb.gain.linearRampToValueAtTime(a.value, end);
  } else {
    graph.state.acidCutoff = a.value;
  }
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
