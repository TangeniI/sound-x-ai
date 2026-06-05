/**
 * lib/tone-synth.ts
 *
 * Tone.js synthesis tuned for techno. Four voices + a drum kit, routed
 * through a reverb/delay send and glued with a master compressor +
 * limiter so it actually sounds like a record, not a test tone.
 *
 *   bass  → MonoSynth (saw + filter envelope, 303-ish) → master
 *   stab  → PolySynth (saw, staccato)        → reverb  → master
 *   lead  → PolySynth (saw, pluck)           → delay + reverb → master
 *   drums → MembraneSynth (kick) / NoiseSynth (clap) / MetalSynth (hats)
 */

import type { NoteEvent } from "../types";

type ToneLib = typeof import("tone");

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
function midiToNote(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export class ToneSynth {
  private Tone: ToneLib | null = null;
  private bass: any = null;
  private stab: any = null;
  private lead: any = null;
  private kick: any = null;
  private clap: any = null;
  private hat: any = null;
  private leadFilter: any = null;
  private stabFilter: any = null;
  private reverb: any = null;
  private initialised = false;
  private ids: number[] = [];

  async init(): Promise<void> {
    if (this.initialised) return;
    const Tone = await import("tone");
    this.Tone = Tone;

    // ── master bus: compressor → limiter → out ──
    const limiter = new Tone.Limiter(-1).toDestination();
    const comp = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.005, release: 0.12 }).connect(limiter);
    const master = new Tone.Gain(0.9).connect(comp);

    // ── sends ──
    const reverb = new Tone.Reverb({ decay: 2.2, preDelay: 0.01, wet: 0.22 }).connect(master);
    await reverb.ready;
    this.reverb = reverb;
    const delay = new Tone.FeedbackDelay({ delayTime: "8n.", feedback: 0.32, wet: 0.18 }).connect(master);

    // ── bass: punchy 303-style mono ──
    this.bass = new Tone.MonoSynth({
      oscillator: { type: "sawtooth" },
      filter: { type: "lowpass", Q: 4, rolloff: -24 },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.25, release: 0.18 },
      filterEnvelope: { attack: 0.006, decay: 0.16, sustain: 0.3, release: 0.2, baseFrequency: 90, octaves: 3.2 },
      volume: -7,
    }).connect(master);

    // ── stabs: short staccato chords ──
    this.stabFilter = new Tone.Filter(1400, "lowpass").connect(reverb);
    this.stabFilter.connect(master);
    this.stab = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.004, decay: 0.16, sustain: 0.0, release: 0.18 },
      volume: -16,
    }).connect(this.stabFilter);

    // ── lead: plucky riff into delay + reverb ──
    this.leadFilter = new Tone.Filter(2600, "lowpass");
    this.leadFilter.connect(delay);
    this.leadFilter.connect(reverb);
    this.leadFilter.connect(master);
    this.lead = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.15, release: 0.25 },
      volume: -14,
    }).connect(this.leadFilter);

    // ── drums ──
    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.028, octaves: 6,
      envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.18 },
      volume: -2,
    }).connect(master);

    this.clap = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.16, sustain: 0, release: 0.05 },
      volume: -12,
    }).connect(new Tone.Filter(1800, "bandpass").connect(master));

    this.hat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: 0.06, release: 0.02 },
      harmonicity: 5.1, modulationIndex: 32, resonance: 5200, octaves: 1.5,
      volume: -20,
    }).connect(master);

    this.initialised = true;
  }

  setBPM(bpm: number): void {
    if (this.Tone) this.Tone.getTransport().bpm.value = bpm;
  }

  /** brightness 0–1 → filter cutoffs (darker techno when low). */
  setBrightness(b: number): void {
    if (!this.Tone) return;
    this.leadFilter?.frequency.rampTo(900 + b * 4500, 0.3);
    this.stabFilter?.frequency.rampTo(700 + b * 2200, 0.3);
    if (this.reverb) this.reverb.wet.rampTo(0.15 + (1 - b) * 0.18, 0.4);
  }

  schedule(notes: NoteEvent[]): void {
    if (!this.Tone || !this.initialised) return;
    const transport = this.Tone.getTransport();
    this.ids.forEach((id) => transport.clear(id));
    this.ids = [];

    notes.forEach((n) => {
      const start = n.startTime;
      const dur = Math.max(0.04, n.endTime - n.startTime);
      const vel = n.velocity / 127;

      const id = transport.schedule((time) => {
        if (n.instrument === "drums") {
          if (n.pitch === 36) this.kick.triggerAttackRelease("C1", "8n", time, vel);
          else if (n.pitch === 38) this.clap.triggerAttackRelease("16n", time, vel);
          else this.hat.triggerAttackRelease(n.pitch === 46 ? "16n" : "32n", time, vel * 0.9);
        } else if (n.instrument === "bass") {
          this.bass.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
        } else if (n.instrument === "stab") {
          this.stab.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
        } else {
          this.lead.triggerAttackRelease(midiToNote(n.pitch), dur, time, vel);
        }
      }, start);
      this.ids.push(id);
    });
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

  /** Export to a MIDI blob with one track per instrument. */
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
    notes.forEach((n) => getTrack(n.instrument).addNote({
      midi: n.pitch, time: n.startTime, duration: Math.max(0.05, n.endTime - n.startTime), velocity: n.velocity / 127,
    }));
    return new Blob([new Uint8Array(midi.toArray())], { type: "audio/midi" });
  }

  async downloadMidi(notes: NoteEvent[], bpm: number, filename = "sound-x-ai.mid"): Promise<void> {
    const blob = await this.exportMidi(notes, bpm);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  dispose(): void {
    this.stop();
    [this.bass, this.stab, this.lead, this.kick, this.clap, this.hat, this.reverb].forEach((n) => n?.dispose?.());
    this.initialised = false;
  }
}

export const toneSynth = new ToneSynth();
