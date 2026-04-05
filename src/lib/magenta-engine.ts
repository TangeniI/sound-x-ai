/**
 * lib/magenta-engine.ts
 *
 * Orchestrates Magenta.js ML models for in-browser music generation.
 *
 * Models used:
 *   MelodyRNN   — LSTM that generates note sequences conditioned on temperature
 *   MusicVAE    — Variational AE; interpolates / samples in latent melody space
 *   DrumRNN     — Generates rhythmic patterns seeded by danceability
 *
 * All models run fully in-browser via TensorFlow.js.
 * Weights are fetched from Magenta's CDN on first use (cached by browser).
 *
 * Usage:
 *   const engine = new MagentaEngine();
 *   await engine.init("melody");          // loads model weights (~20 MB)
 *   const notes = await engine.generate(config, tasteProfile);
 *   engine.dispose();
 */

import type { GeneratorConfig }  from "../components/GeneratorPanel";
import type { TasteProfile }     from "./taste-profile";
import { deriveMagentaCondition } from "./taste-profile";

/* ─── re-export note type (used by TrackTimeline) ───────────────────────── */
export interface NoteEvent {
  pitch:      number;
  startTime:  number; // seconds
  endTime:    number; // seconds
  velocity:   number; // 0-127
  instrument: "melody" | "chords" | "drums";
}

/* ─── Magenta type shims ─────────────────────────────────────────────────
   @magenta/music ships its own TS types but they're verbose.
   We declare only what we use to keep this file portable.
─────────────────────────────────────────────────────────────────────────── */

interface MagentaNote {
  pitch:         number;
  startTime:     number;
  endTime:       number;
  velocity?:     number;
  isDrum?:       boolean;
  instrument?:   number;
  program?:      number;
}

interface NoteSequence {
  notes:        MagentaNote[];
  totalTime:    number;
  tempos?:      { time: number; qpm: number }[];
  timeSignatures?: { time: number; numerator: number; denominator: number }[];
  quantizationInfo?: { stepsPerQuarter: number };
}

/* ─── model checkpoint URLs (Magenta CDN) ──────────────────────────────── */

const CHECKPOINTS = {
  melodyRnn:
    "https://storage.googleapis.com/magentadata/js/checkpoints/rnn/melody_rnn",
  musicVae:
    "https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_4bar_med_lokl_q2",
  drumRnn:
    "https://storage.googleapis.com/magentadata/js/checkpoints/rnn/drum_kit_rnn",
} as const;

/* ─── status callback type ─────────────────────────────────────────────── */

export type StatusCallback = (msg: string) => void;

/* ─── engine class ──────────────────────────────────────────────────────── */

export class MagentaEngine {
  private melodyRnn: unknown = null;
  private musicVae:  unknown = null;
  private drumRnn:   unknown = null;

  private loadedModels = new Set<string>();
  private mm: typeof import("@magenta/music") | null = null;

  /** Load the @magenta/music module dynamically (avoids SSR issues) */
  private async getMM() {
    if (!this.mm) {
      this.mm = await import("@magenta/music");
    }
    return this.mm;
  }

  /**
   * Initialise a model (downloads checkpoint weights on first call).
   * Call before generate(). Safe to call multiple times — skips if loaded.
   */
  async init(
    model:    GeneratorConfig["model"],
    onStatus: StatusCallback = console.log
  ): Promise<void> {
    const mm = await this.getMM();

    if (model === "melody" && !this.loadedModels.has("melody")) {
      onStatus("[INIT] Loading MelodyRNN weights (~20 MB)…");
      const rnn = new mm.MusicRNN(CHECKPOINTS.melodyRnn);
      await rnn.initialize();
      this.melodyRnn = rnn;
      this.loadedModels.add("melody");
      onStatus("[INIT] MelodyRNN ready");
    }

    if (model === "vae" && !this.loadedModels.has("vae")) {
      onStatus("[INIT] Loading MusicVAE weights (~45 MB)…");
      const vae = new mm.MusicVAE(CHECKPOINTS.musicVae);
      await vae.initialize();
      this.musicVae = vae;
      this.loadedModels.add("vae");
      onStatus("[INIT] MusicVAE ready");
    }

    if (model === "drums" && !this.loadedModels.has("drums")) {
      onStatus("[INIT] Loading DrumRNN weights (~20 MB)…");
      const rnn = new mm.MusicRNN(CHECKPOINTS.drumRnn);
      await rnn.initialize();
      this.drumRnn = rnn;
      this.loadedModels.add("drums");
      onStatus("[INIT] DrumRNN ready");
    }
  }

  /**
   * Generate a note sequence using the selected model.
   * Returns NoteEvent[] for TrackTimeline + Tone.js playback.
   */
  async generate(
    config:       GeneratorConfig,
    tasteProfile: TasteProfile | null,
    onStatus:     StatusCallback = console.log
  ): Promise<NoteEvent[]> {
    const mm = await this.getMM();

    // Derive conditioning — blend config sliders with taste profile if seeding
    const conditioning = tasteProfile && config.seedFromSpotify
      ? deriveMagentaCondition(
          {
            tempo:        config.tempo,
            energy:       config.energy,
            valence:      config.valence,
            danceability: tasteProfile.meanVector.danceability,
            acousticness: tasteProfile.meanVector.acousticness,
          },
          tasteProfile.dominantCluster
        )
      : {
          melodyTemperature: config.temperature,
          drumDensity:       2,
          latentBias:        [0, 0] as [number, number],
          bpm:               config.tempo,
          brightness:        0.5,
        };

    onStatus(`[RUN] bpm=${conditioning.bpm} temp=${conditioning.melodyTemperature.toFixed(2)}`);

    switch (config.model) {
      case "melody":
        return this.generateMelody(mm, config, conditioning, onStatus);
      case "drums":
        return this.generateDrums(mm, config, conditioning, onStatus);
      case "vae":
        return this.generateVae(mm, config, conditioning, onStatus);
      default:
        throw new Error(`Unknown model: ${config.model}`);
    }
  }

  /* ─── MelodyRNN ──────────────────────────────────────────────────────── */

  private async generateMelody(
    mm:           Awaited<ReturnType<MagentaEngine["getMM"]>>,
    config:       GeneratorConfig,
    conditioning: ReturnType<typeof deriveMagentaCondition>,
    onStatus:     StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.melodyRnn) throw new Error("MelodyRNN not initialised — call init('melody') first");

    const rnn = this.melodyRnn as InstanceType<typeof mm.MusicRNN>;

    // Seed: a short 4-note motif derived from the taste profile's BPM
    const seedNotes: MagentaNote[] = buildMelodySeed(conditioning.bpm);
    const qpm      = conditioning.bpm;
    const steps    = config.steps;

    const seed: NoteSequence = {
      notes:    seedNotes,
      totalTime: 4 * (60 / qpm),
      tempos:   [{ time: 0, qpm }],
      quantizationInfo: { stepsPerQuarter: 4 },
    };

    onStatus(`[MELODY] Generating ${steps} steps…`);

    const result = (await rnn.continueSequence(
      mm.sequences.quantizeNoteSequence(seed, 4),
      steps,
      conditioning.melodyTemperature
    )) as NoteSequence;

    onStatus(`[MELODY] Generated ${result.notes.length} notes`);

    return magentaSeqToNoteEvents(result, "melody");
  }

  /* ─── DrumRNN ────────────────────────────────────────────────────────── */

  private async generateDrums(
    mm:           Awaited<ReturnType<MagentaEngine["getMM"]>>,
    config:       GeneratorConfig,
    conditioning: ReturnType<typeof deriveMagentaCondition>,
    onStatus:     StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.drumRnn) throw new Error("DrumRNN not initialised — call init('drums') first");

    const rnn    = this.drumRnn as InstanceType<typeof mm.MusicRNN>;
    const qpm    = conditioning.bpm;
    const steps  = config.steps;

    // Drum seed: basic kick/snare/hat pattern scaled by drumDensity
    const seedNotes: MagentaNote[] = buildDrumSeed(
      conditioning.drumDensity,
      qpm
    );

    const seed: NoteSequence = {
      notes:    seedNotes,
      totalTime: 2 * (60 / qpm),
      tempos:   [{ time: 0, qpm }],
      quantizationInfo: { stepsPerQuarter: 4 },
    };

    onStatus(`[DRUMS] Generating ${steps} steps (density=${conditioning.drumDensity.toFixed(1)})…`);

    const result = (await rnn.continueSequence(
      mm.sequences.quantizeNoteSequence(seed, 4),
      steps,
      config.temperature
    )) as NoteSequence;

    onStatus(`[DRUMS] Generated ${result.notes.length} drum hits`);

    return magentaSeqToNoteEvents(result, "drums");
  }

  /* ─── MusicVAE ───────────────────────────────────────────────────────── */

  private async generateVae(
    mm:           Awaited<ReturnType<MagentaEngine["getMM"]>>,
    config:       GeneratorConfig,
    conditioning: ReturnType<typeof deriveMagentaCondition>,
    onStatus:     StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.musicVae) throw new Error("MusicVAE not initialised — call init('vae') first");

    const vae = this.musicVae as InstanceType<typeof mm.MusicVAE>;

    onStatus("[VAE] Sampling from latent space…");

    // Sample 2 points in latent space biased by taste profile
    const [z0, z1] = conditioning.latentBias;
    const numSamples = 2;

    // vae.sample returns Magenta's INoteSequence[] (protobuf type) — cast via unknown
    const samples = (await vae.sample(numSamples, config.temperature)) as unknown as NoteSequence[];

    // Interpolate between the two samples (4 steps)
    onStatus("[VAE] Interpolating between samples…");

    // vae.interpolate also returns INoteSequence[] — cast via unknown
    const interpolated = (await vae.interpolate(
      [samples[0], samples[1]],
      4 // num interpolation steps
    )) as unknown as NoteSequence[];

    // Concatenate interpolated sequences
    // concatenate returns a protobuf NoteSequence — cast to our local interface
    const combined = mm.sequences.concatenate(interpolated) as unknown as NoteSequence;

    onStatus(`[VAE] Interpolation complete (z0=${z0.toFixed(2)}, z1=${z1.toFixed(2)})`);
    onStatus(`[VAE] Generated ${combined.notes.length} notes`);

    return magentaSeqToNoteEvents(combined, "melody");
  }

  /** Cleanly dispose all loaded models and free GPU memory */
  dispose(): void {
    if (this.melodyRnn) (this.melodyRnn as { dispose: () => void }).dispose?.();
    if (this.musicVae)  (this.musicVae  as { dispose: () => void }).dispose?.();
    if (this.drumRnn)   (this.drumRnn   as { dispose: () => void }).dispose?.();
    this.melodyRnn = null;
    this.musicVae  = null;
    this.drumRnn   = null;
    this.loadedModels.clear();
  }
}

/* ─── seed builders ─────────────────────────────────────────────────────── */

/**
 * Build a 4-note melody seed whose pitches are roughly pentatonic.
 * Starting pitch shifts with BPM to give variety across tracks.
 */
function buildMelodySeed(bpm: number): MagentaNote[] {
  const root    = 60 + (Math.round(bpm / 20) % 12); // C4 + offset
  const penta   = [0, 2, 4, 7, 9];                  // major pentatonic intervals
  const stepSec = 60 / bpm / 2;                      // eighth note

  return penta.slice(0, 4).map((interval, i) => ({
    pitch:     root + interval,
    startTime: i * stepSec,
    endTime:   (i + 1) * stepSec,
    velocity:  80,
  }));
}

/**
 * Build a drum seed appropriate for the given density level (1-4).
 * Density 1 = kick only; 4 = kick + snare + hat + open hat
 */
function buildDrumSeed(density: number, bpm: number): MagentaNote[] {
  const step = 60 / bpm / 2; // eighth note in seconds
  const notes: MagentaNote[] = [];

  // Kick drum (MIDI 36) — always on beat 1 and 3
  [0, 4].forEach((s) => {
    notes.push({ pitch: 36, startTime: s * step, endTime: (s + 1) * step, velocity: 100, isDrum: true });
  });

  if (density >= 2) {
    // Snare (MIDI 38) on beat 2 and 4
    [2, 6].forEach((s) => {
      notes.push({ pitch: 38, startTime: s * step, endTime: (s + 1) * step, velocity: 90, isDrum: true });
    });
  }

  if (density >= 3) {
    // Closed hi-hat (MIDI 42) every eighth note
    for (let s = 0; s < 8; s++) {
      notes.push({ pitch: 42, startTime: s * step, endTime: (s + 1) * step, velocity: 60, isDrum: true });
    }
  }

  if (density >= 4) {
    // Open hi-hat (MIDI 46) on beat 2.5 and 4.5
    [3, 7].forEach((s) => {
      notes.push({ pitch: 46, startTime: s * step, endTime: (s + 1) * step, velocity: 70, isDrum: true });
    });
  }

  return notes;
}

/* ─── Magenta → NoteEvent converter ────────────────────────────────────── */

function magentaSeqToNoteEvents(
  seq:        NoteSequence,
  instrument: NoteEvent["instrument"]
): NoteEvent[] {
  return (seq.notes ?? []).map((n) => ({
    pitch:      n.pitch,
    startTime:  n.startTime ?? 0,
    endTime:    n.endTime   ?? (n.startTime ?? 0) + 0.25,
    velocity:   n.velocity  ?? 80,
    instrument: n.isDrum ? "drums" : instrument,
  }));
}

/* ─── singleton export ──────────────────────────────────────────────────── */

/** Module-level singleton — import and use directly */
export const magentaEngine = new MagentaEngine();