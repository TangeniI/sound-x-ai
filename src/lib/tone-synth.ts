/**
 * lib/tone-synth.ts
 *
 * Tone.js synthesis tuned for techno, with:
 *   • a reusable voice graph (used for both live playback and offline render)
 *   • sidechain "pump" compression — bass/stab/lead duck on every kick
 *   • riser + impact transition FX
 *   • offline WAV + stem rendering via Tone.Offline
 *
 * Routing:
 *   kick / clap / hat ─────────────────────────► master
 *   bass / stab / lead ──► sidechain (pumped) ──► master
 *   master → compressor → limiter → destination
 */

import type { NoteEvent } from "../types";

type ToneLib = typeof import("tone");

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToNote(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Voices = Record<string, any>;

/** Build the full synth graph on the *current* Tone context (live or offline). */
function buildVoices(Tone: ToneLib): Voices {
  const limiter = new Tone.Limiter(-1).toDestination();
  const comp = new Tone.Compressor({ threshold: -16, ratio: 3, attack: 0.005, release: 0.12 }).connect(limiter);
  const master = new Tone.Gain(0.9).connect(comp);

  // Freeverb (algorithmic) instead of convolution Reverb — no impulse-response
  // generation, so offline WAV/stem rendering is many times faster.
  const reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 3000, wet: 0.2 }).connect(master);
  const delay = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.3, wet: 0.16 }).connect(master);

  // sidechain bus — bass/stab/lead route through here and get ducked on the kick
  const sidechain = new Tone.Gain(1).connect(master);

  const bass = new Tone.MonoSynth({
    oscillator: { type: "sawtooth" },
    filter: { type: "lowpass", Q: 4, rolloff: -24 },
    envelope: { attack: 0.005, decay: 0.18, sustain: 0.25, release: 0.18 },
    filterEnvelope: { attack: 0.006, decay: 0.16, sustain: 0.3, release: 0.2, baseFrequency: 90, octaves: 3.2 },
    volume: -6,
  }).connect(sidechain);

  const stabFilter = new Tone.Filter(1400, "lowpass");
  stabFilter.connect(sidechain);
  stabFilter.connect(reverb);
  const stab = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.004, decay: 0.16, sustain: 0.0, release: 0.18 },
    volume: -15,
  }).connect(stabFilter);

  const leadFilter = new Tone.Filter(2600, "lowpass");
  leadFilter.connect(sidechain);
  leadFilter.connect(delay);
  leadFilter.connect(reverb);
  const lead = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.005, decay: 0.18, sustain: 0.15, release: 0.25 },
    volume: -13,
  }).connect(leadFilter);

  const kick = new Tone.MembraneSynth({
    pitchDecay: 0.028, octaves: 6,
    envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.18 },
    volume: -1,
  }).connect(master);

  const clap = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.05 },
    volume: -12,
  }).connect(new Tone.Filter(1800, "bandpass").connect(master));

  // NoiseSynth + highpass for hats — envelope-based (no oscillator), so dense
  // 16th hats render correctly offline (MetalSynth's oscillator can't retrigger there)
  const hatFilter = new Tone.Filter(8500, "highpass").connect(master);
  const hat = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    volume: -17,
  }).connect(hatFilter);

  // transition FX: riser (continuous noise, gated/swept) + impact (boom + crash)
  const riserGain = new Tone.Gain(0.0001).connect(reverb);
  riserGain.connect(master);
  const riserFilter = new Tone.Filter(300, "highpass").connect(riserGain);
  const riserNoise = new Tone.Noise("white").connect(riserFilter);
  riserNoise.start();

  const boom = new Tone.MembraneSynth({
    pitchDecay: 0.08, octaves: 4,
    envelope: { attack: 0.001, decay: 0.8, sustain: 0, release: 0.4 },
    volume: 0,
  }).connect(master);
  const crash = new Tone.NoiseSynth({
    noise: { type: "white" },
    envelope: { attack: 0.001, decay: 0.6, sustain: 0, release: 0.4 },
    volume: -18,
  }).connect(reverb);

  return { limiter, comp, master, reverb, delay, sidechain, bass, stab, stabFilter, lead, leadFilter, kick, clap, hat, riserGain, riserFilter, riserNoise, boom, crash };
}

/** Trigger one note on the given voice graph at audio-time `time`. */
function triggerNote(voices: Voices, n: NoteEvent, time: number): void {
  const dur = Math.max(0.04, n.endTime - n.startTime);
  const vel = n.velocity / 127;

  switch (n.instrument) {
    case "drums":
      if (n.pitch === 36) voices.kick.triggerAttackRelease("C1", "8n", time, vel);
      else if (n.pitch === 38) voices.clap.triggerAttackRelease("16n", time, vel);
      else voices.hat.triggerAttackRelease(n.pitch === 46 ? "16n" : "32n", time, vel * 0.85);
      break;
    case "bass":
      voices.bass.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
      break;
    case "stab":
      voices.stab.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
      break;
    case "lead":
      voices.lead.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
      break;
    case "fx":
      if (n.pitch === 1) {
        const g = voices.riserGain.gain;
        g.cancelScheduledValues(time);
        g.setValueAtTime(0.0001, time);
        g.exponentialRampToValueAtTime(0.35, time + dur * 0.92);
        g.linearRampToValueAtTime(0.0001, time + dur);
        voices.riserFilter.frequency.cancelScheduledValues(time);
        voices.riserFilter.frequency.setValueAtTime(300, time);
        voices.riserFilter.frequency.exponentialRampToValueAtTime(7000, time + dur);
      } else {
        voices.boom.triggerAttackRelease("C1", "2n", time, 1);
        voices.crash.triggerAttackRelease("1n", time, 0.5);
      }
      break;
  }
}

/** Schedule notes (and the sidechain pump) onto a transport. Returns event ids.
 *  `offset` shifts everything by a hair so nothing lands at transport-time 0
 *  (which would collide with the params' initial value during offline render). */
function scheduleInto(transport: ReturnType<ToneLib["getTransport"]>, voices: Voices, notes: NoteEvent[], offset = 0): number[] {
  const ids: number[] = [];
  const beatSec = 60 / transport.bpm.value;

  notes.forEach((n) => {
    ids.push(transport.schedule((t) => triggerNote(voices, n, t), n.startTime + offset));
    // pump the sidechain bus down on every kick, recovering over ~55% of a beat
    if (n.instrument === "drums" && n.pitch === 36) {
      ids.push(transport.schedule((t) => {
        const tt = Math.max(t, 0.001);
        const g = voices.sidechain.gain;
        g.cancelScheduledValues(tt);
        g.setValueAtTime(0.32, tt);
        g.linearRampToValueAtTime(1.0, tt + beatSec * 0.55);
      }, n.startTime + offset));
    }
  });
  return ids;
}

export class ToneSynth {
  private Tone: ToneLib | null = null;
  private voices: Voices | null = null;
  private initialised = false;
  private ids: number[] = [];

  async init(): Promise<void> {
    if (this.initialised) return;
    this.Tone = await import("tone");
    this.voices = buildVoices(this.Tone);
    this.initialised = true;
  }

  setBPM(bpm: number): void {
    if (this.Tone) this.Tone.getTransport().bpm.value = bpm;
  }

  setBrightness(b: number): void {
    if (!this.voices) return;
    this.voices.leadFilter?.frequency.rampTo(900 + b * 4500, 0.3);
    this.voices.stabFilter?.frequency.rampTo(700 + b * 2200, 0.3);
    this.voices.reverb?.wet.rampTo(0.14 + (1 - b) * 0.16, 0.4);
  }

  schedule(notes: NoteEvent[]): void {
    if (!this.Tone || !this.voices || !this.initialised) return;
    const transport = this.Tone.getTransport();
    this.ids.forEach((id) => transport.clear(id));
    this.ids = scheduleInto(transport, this.voices, notes);
  }

  async play(): Promise<void> {
    if (!this.Tone) return;
    await this.Tone.start();
    const t = this.Tone.getTransport();
    t.stop();
    t.position = 0;
    t.start();
  }

  stop(): void {
    if (this.Tone) this.Tone.getTransport().stop();
  }

  getPositionSeconds(): number {
    return this.Tone ? this.Tone.getTransport().seconds : 0;
  }

  /* ─────────────────── offline render → WAV / stems ─────────────────── */

  private async renderBuffer(notes: NoteEvent[], bpm: number): Promise<AudioBuffer> {
    const Tone = this.Tone ?? (await import("tone"));
    this.Tone = Tone;
    const tail = 2.5;
    const dur = (notes.length ? Math.max(...notes.map((n) => n.endTime)) : 8) + tail;
    const buffer = await Tone.Offline(({ transport }) => {
      transport.bpm.value = bpm;
      const voices = buildVoices(Tone);
      scheduleInto(transport, voices, notes, 0.02);
      transport.start(0);
    }, dur + 0.05, 2, 44100);
    return buffer.get() as AudioBuffer;
  }

  async downloadWav(notes: NoteEvent[], bpm: number, filename = "sound-x-ai.wav"): Promise<void> {
    const buf = await this.renderBuffer(notes, bpm);
    triggerDownload(audioBufferToWav(buf), filename);
  }

  /** Render each instrument group to its own WAV and download them. */
  async downloadStems(notes: NoteEvent[], bpm: number, onStatus: (m: string) => void = () => {}): Promise<void> {
    const groups: Record<string, NoteEvent["instrument"][]> = {
      drums: ["drums", "fx"],
      bass: ["bass"],
      stab: ["stab"],
      lead: ["lead"],
    };
    for (const [name, insts] of Object.entries(groups)) {
      const subset = notes.filter((n) => insts.includes(n.instrument));
      if (!subset.length) continue;
      onStatus(`[STEMS] rendering ${name}…`);
      const buf = await this.renderBuffer(subset, bpm);
      triggerDownload(audioBufferToWav(buf), `sound-x-ai-${name}.wav`);
      await new Promise((r) => setTimeout(r, 350)); // stagger browser downloads
    }
    onStatus("[STEMS] done");
  }

  /* ─────────────────────────── MIDI export ──────────────────────────── */

  async exportMidi(notes: NoteEvent[], bpm: number): Promise<Blob> {
    const { Midi } = await import("@tonejs/midi");
    const midi = new Midi();
    midi.header.setTempo(bpm);
    const tracks: Record<string, ReturnType<typeof midi.addTrack>> = {};
    const getTrack = (inst: string) => {
      if (!tracks[inst]) {
        const tr = midi.addTrack();
        tr.name = inst;
        if (inst === "drums") tr.channel = 9;
        tracks[inst] = tr;
      }
      return tracks[inst];
    };
    notes.filter((n) => n.instrument !== "fx").forEach((n) =>
      getTrack(n.instrument).addNote({ midi: n.pitch, time: n.startTime, duration: Math.max(0.05, n.endTime - n.startTime), velocity: n.velocity / 127 })
    );
    return new Blob([new Uint8Array(midi.toArray())], { type: "audio/midi" });
  }

  async downloadMidi(notes: NoteEvent[], bpm: number, filename = "sound-x-ai.mid"): Promise<void> {
    triggerDownload(await this.exportMidi(notes, bpm), filename);
  }

  dispose(): void {
    this.stop();
    if (this.voices) Object.values(this.voices).forEach((n) => n?.dispose?.());
    this.initialised = false;
  }
}

/* ───────────────────────────── helpers ───────────────────────────── */

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Encode an AudioBuffer as a 16-bit PCM WAV blob. */
function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const blockAlign = numCh * 2;
  const dataLen = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataLen);
  const view = new DataView(ab);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataLen, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); writeStr(36, "data"); view.setUint32(40, dataLen, true);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

export const toneSynth = new ToneSynth();
