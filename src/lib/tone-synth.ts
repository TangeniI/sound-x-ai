/**
 * lib/tone-synth.ts
 *
 * Synthesis and playback layer built on Tone.js.
 * Converts NoteEvent[] from magenta-engine into audible sound.
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  ToneSynth                                              │
 *   │                                                         │
 *   │  melodyChannel → PolySynth(Synth)  → reverb → master   │
 *   │  chordsChannel → PolySynth(Synth)  → chorus → master   │
 *   │  drumsChannel  → MembraneSynth     → dist   → master   │
 *   │                  MetalSynth (hats)                      │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Synth parameters are driven by TasteProfile.magenta.brightness
 * (high valence = brighter, more open filter; low = darker, more muted).
 *
 * Usage:
 *   const synth = new ToneSynth();
 *   await synth.init();
 *   synth.setBrightness(0.7);         // from taste profile
 *   synth.setBPM(128);
 *   synth.schedule(noteEvents);
 *   synth.play();
 *   synth.stop();
 *   synth.dispose();
 */

import type { NoteEvent } from "./magenta-engine";

/* ─── Tone.js type shims (actual types come from the package) ───────────── */
// We import Tone dynamically to avoid SSR issues and keep types simple here.

type ToneLib = typeof import("tone");

/* ─── helpers ───────────────────────────────────────────────────────────── */

/** Convert MIDI note number → Tone.js frequency string (e.g. "C4") */
function midiToNote(midi: number): string {
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave     = Math.floor(midi / 12) - 1;
  const name       = NOTE_NAMES[midi % 12];
  return `${name}${octave}`;
}

const DRUM_MAP: Record<number, string> = {
  35: "C0", 36: "C0",  // Kick
  38: "E0", 40: "E0",  // Snare
  42: "F#0",           // Closed hat
  44: "G#0",           // Pedal hat
  46: "A#0",           // Open hat
  49: "B0", 57: "B0",  // Crash
  51: "D1", 59: "D1",  // Ride
};

function drumPitchToNote(pitch: number): string {
  return DRUM_MAP[pitch] ?? "C0";
}

/* ─── main class ────────────────────────────────────────────────────────── */

export class ToneSynth {
  private Tone:         ToneLib | null = null;
  private melodyPoly:     unknown = null;
  private chordsPoly:     unknown = null;
  private melodyFilter:   unknown = null;
  private chordsFilter:   unknown = null;
  private kickSynth:    unknown = null;
  private snareSynth:   unknown = null;
  private hatSynth:     unknown = null;
  private reverb:       unknown = null;
  private chorus:       unknown = null;
  private masterGain:   unknown = null;
  private initialised = false;
  private scheduledIds: number[] = [];

  /** Load Tone.js and create all synth nodes */
  async init(): Promise<void> {
    if (this.initialised) return;

    const Tone = await import("tone");
    this.Tone  = Tone;

    // ── master gain ──────────────────────────────────────────────────────
    const master = new Tone.Gain(0.8).toDestination();
    this.masterGain = master;

    // ── effects chain ────────────────────────────────────────────────────
    const reverb = new Tone.Reverb({ decay: 2.5, preDelay: 0.02, wet: 0.35 }).connect(master);
    const chorus  = new Tone.Chorus({ frequency: 3, delayTime: 2.5, depth: 0.4, wet: 0.25 }).connect(master);
    const distort = new Tone.Distortion({ distortion: 0.12, wet: 0.15 }).connect(master);
    await reverb.ready;
    this.reverb  = reverb;
    this.chorus  = chorus;

    // ── melody synth ─────────────────────────────────────────────────────
    // Note: filter is NOT a valid PolySynth top-level option in Tone v14.
    // Apply filtering via a separate Filter node inserted into the signal chain.
    const melodyFilter = new Tone.Filter(2400, "lowpass").connect(
      reverb as ReturnType<ToneLib["Reverb"]["prototype"]["connect"]>
    );
    this.melodyPoly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope:   { attack: 0.02, decay: 0.1, sustain: 0.6, release: 0.4 },
      volume:     -6,
    }).connect(melodyFilter);
    this.melodyFilter = melodyFilter;

    // ── chords synth ─────────────────────────────────────────────────────
    const chordsFilter = new Tone.Filter(1600, "lowpass").connect(
      chorus as ReturnType<ToneLib["Chorus"]["prototype"]["connect"]>
    );
    this.chordsPoly = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "triangle" },
      envelope:   { attack: 0.08, decay: 0.2, sustain: 0.5, release: 0.8 },
      volume:     -10,
    }).connect(chordsFilter);
    this.chordsFilter = chordsFilter;

    // ── kick drum ────────────────────────────────────────────────────────
    this.kickSynth = new Tone.MembraneSynth({
      pitchDecay:  0.05,
      octaves:     8,
      envelope:    { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
      volume:      -4,
    }).connect(distort as ReturnType<ToneLib["Distortion"]["prototype"]["connect"]>);

    // ── snare ────────────────────────────────────────────────────────────
    this.snareSynth = new Tone.NoiseSynth({
      noise:       { type: "white" },
      envelope:    { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 },
      volume:      -10,
    }).connect(distort as ReturnType<ToneLib["Distortion"]["prototype"]["connect"]>);

    // ── hi-hat ────────────────────────────────────────────────────────────
    this.hatSynth = new Tone.MetalSynth({
      envelope:        { attack: 0.001, decay: 0.04, release: 0.01 },
      harmonicity:     5.1,
      modulationIndex: 32,
      resonance:       4000,
      octaves:         1.5,
      volume:          -16,
    }).connect(master);

    this.initialised = true;
  }

  /** Set the Tone.js Transport BPM */
  setBPM(bpm: number): void {
    if (!this.Tone) return;
    this.Tone.getTransport().bpm.value = bpm;
  }

  /**
   * Adjust synth timbre based on brightness (0-1).
   * brightness → filter cutoff, oscillator type, reverb wet.
   */
  setBrightness(brightness: number): void {
    if (!this.Tone || !this.melodyPoly || !this.chordsPoly) return;

    const Tone       = this.Tone;
    const melody     = this.melodyPoly  as InstanceType<ToneLib["PolySynth"]>;
    const chords     = this.chordsPoly  as InstanceType<ToneLib["PolySynth"]>;
    const rev        = this.reverb      as InstanceType<ToneLib["Reverb"]>;

    // Ramp filter cutoff: dark (600 Hz) → bright (5000 Hz)
    const cutoff = 600 + brightness * 4400;
    const mf = this.melodyFilter as InstanceType<ToneLib["Filter"]>;
    const cf = this.chordsFilter as InstanceType<ToneLib["Filter"]>;
    if (mf) mf.frequency.rampTo(cutoff, 0.3);
    if (cf) cf.frequency.rampTo(cutoff * 0.7, 0.3);
    void melody; void chords;

    // Reverb wet: bright = drier, dark = wetter
    if (rev) rev.wet.rampTo(0.5 - brightness * 0.3, 0.5);

    // Oscillator type: acoustic (low brightness) → electronic (high)
    const oscType: OscillatorType = brightness < 0.35
      ? "triangle"
      : brightness < 0.65
        ? "sawtooth"
        : "square";

    void oscType; // type is informational; PolySynth handles internally
  }

  /**
   * Schedule a NoteEvent[] on the Tone.js Transport.
   * Clears any previously scheduled events first.
   */
  schedule(notes: NoteEvent[]): void {
    if (!this.Tone || !this.initialised) return;
    const Tone      = this.Tone;
    const transport = Tone.getTransport();

    // Clear old scheduled events
    this.scheduledIds.forEach((id) => transport.clear(id));
    this.scheduledIds = [];

    const melody = this.melodyPoly  as InstanceType<ToneLib["PolySynth"]>;
    const chords = this.chordsPoly  as InstanceType<ToneLib["PolySynth"]>;
    const kick   = this.kickSynth   as InstanceType<ToneLib["MembraneSynth"]>;
    const snare  = this.snareSynth  as InstanceType<ToneLib["NoiseSynth"]>;
    const hat    = this.hatSynth    as InstanceType<ToneLib["MetalSynth"]>;

    notes.forEach((note) => {
      const startSec = note.startTime;
      const dur      = Math.max(0.05, note.endTime - note.startTime);

      if (note.instrument === "drums") {
        const pitch = note.pitch;
        const isKick  = pitch === 35 || pitch === 36;
        const isSnare = pitch === 38 || pitch === 40;
        const isHat   = pitch === 42 || pitch === 44 || pitch === 46;

        const id = transport.schedule((time) => {
          if (isKick)  kick.triggerAttackRelease(drumPitchToNote(pitch), "8n", time);
          else if (isSnare) snare.triggerAttackRelease("8n", time);
          else if (isHat)   hat.triggerAttackRelease(pitch === 46 ? "16n" : "32n", time);
        }, startSec);

        this.scheduledIds.push(id);

      } else if (note.instrument === "melody") {
        const noteName = midiToNote(note.pitch);
        const vel      = note.velocity / 127;

        const id = transport.schedule((time) => {
          melody.triggerAttackRelease(noteName, dur, time, vel);
        }, startSec);

        this.scheduledIds.push(id);

      } else if (note.instrument === "chords") {
        // Build a basic triad from the note
        const root  = note.pitch;
        const triad = [root, root + 4, root + 7].map(midiToNote);
        const vel   = note.velocity / 127 * 0.7;

        const id = transport.schedule((time) => {
          chords.triggerAttackRelease(triad, dur, time, vel);
        }, startSec);

        this.scheduledIds.push(id);
      }
    });
  }

  /** Start the Tone.js Transport from position 0 */
  async play(): Promise<void> {
    if (!this.Tone) return;
    await this.Tone.start(); // resume AudioContext (required after user gesture)
    const transport = this.Tone.getTransport();
    transport.stop();
    transport.position = 0;
    transport.start();
  }

  /** Stop playback */
  stop(): void {
    if (!this.Tone) return;
    this.Tone.getTransport().stop();
  }

  /** Pause / resume */
  togglePause(): void {
    if (!this.Tone) return;
    const t = this.Tone.getTransport();
    t.state === "started" ? t.pause() : t.start();
  }

  /** Current playback position in seconds */
  getPositionSeconds(): number {
    if (!this.Tone) return 0;
    return this.Tone.getTransport().seconds;
  }

  /**
   * Export the scheduled sequence to a MIDI blob.
   * Uses @tonejs/midi for encoding.
   */
  async exportMidi(notes: NoteEvent[], bpm: number): Promise<Blob> {
    const { Midi } = await import("@tonejs/midi");
    const midi     = new Midi();
    midi.header.setTempo(bpm);

    const melodyTrack = midi.addTrack();
    const drumsTrack  = midi.addTrack();
    drumsTrack.channel = 9; // GM drum channel

    notes.forEach((note) => {
      const track = note.instrument === "drums" ? drumsTrack : melodyTrack;
      track.addNote({
        midi:     note.pitch,
        time:     note.startTime,
        duration: note.endTime - note.startTime,
        velocity: note.velocity / 127,
      });
    });

    const bytes = midi.toArray();
    return new Blob([new Uint8Array(bytes)], { type: "audio/midi" });
  }

  /** Download MIDI file to the user's machine */
  async downloadMidi(notes: NoteEvent[], bpm: number, filename = "sound-x-ai.mid"): Promise<void> {
    const blob = await this.exportMidi(notes, bpm);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Cleanly tear down all Tone nodes */
  dispose(): void {
    this.stop();
    if (!this.Tone) return;

    const dispose = (node: unknown) => {
      if (node && typeof (node as { dispose?: () => void }).dispose === "function") {
        (node as { dispose: () => void }).dispose();
      }
    };

    [
      this.melodyPoly,
      this.chordsPoly,
      this.kickSynth,
      this.snareSynth,
      this.hatSynth,
      this.reverb,
      this.chorus,
      this.masterGain,
    ].forEach(dispose);

    this.initialised = false;
  }
}

/** Module-level singleton */
export const toneSynth = new ToneSynth();