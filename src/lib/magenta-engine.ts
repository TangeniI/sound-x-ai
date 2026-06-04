/**
 * lib/magenta-engine.ts
 *
 * OPTIONAL "deep mode" — Google Magenta.js models running in-browser via
 * TensorFlow.js. This is *not* on the critical path: the bespoke
 * generative-engine.ts is the default and always works. Magenta is loaded
 * lazily only when the user explicitly selects a deep model, because it
 * fetches 20–45 MB of weights from Google's CDN on first use.
 *
 *   magenta-melody → MelodyRNN  (LSTM note continuation)
 *   magenta-drums  → DrumsRNN   (rhythmic continuation)
 *   magenta-vae    → MusicVAE   (latent-space sampling + interpolation)
 */

import type { AudioFeatures, EngineId, GeneratorConfig, NoteEvent } from "../types";
import { buildSingleTrackProfile, deriveMagentaCondition } from "./taste-profile";

/* ─── Magenta type shims (only what we use) ────────────────────────── */

interface MagentaNote {
  pitch: number;
  startTime?: number;
  endTime?: number;
  velocity?: number;
  isDrum?: boolean;
}
interface MNoteSequence {
  notes: MagentaNote[];
  totalTime?: number;
  tempos?: { time: number; qpm: number }[];
  quantizationInfo?: { stepsPerQuarter: number };
}

const CHECKPOINTS = {
  melodyRnn: "https://storage.googleapis.com/magentadata/js/checkpoints/rnn/melody_rnn",
  musicVae: "https://storage.googleapis.com/magentadata/js/checkpoints/music_vae/mel_4bar_med_lokl_q2",
  drumRnn: "https://storage.googleapis.com/magentadata/js/checkpoints/rnn/drum_kit_rnn",
} as const;

export type StatusCallback = (msg: string) => void;

export class MagentaEngine {
  private melodyRnn: unknown = null;
  private musicVae: unknown = null;
  private drumRnn: unknown = null;
  private loaded = new Set<EngineId>();
  private mm: typeof import("@magenta/music") | null = null;

  private async getMM() {
    if (!this.mm) this.mm = await import("@magenta/music");
    return this.mm;
  }

  async init(engine: EngineId, onStatus: StatusCallback = console.log): Promise<void> {
    const mm = await this.getMM();
    if (engine === "magenta-melody" && !this.loaded.has(engine)) {
      onStatus("[INIT] Downloading MelodyRNN weights (~20 MB)…");
      const rnn = new mm.MusicRNN(CHECKPOINTS.melodyRnn);
      await rnn.initialize();
      this.melodyRnn = rnn;
      this.loaded.add(engine);
    } else if (engine === "magenta-drums" && !this.loaded.has(engine)) {
      onStatus("[INIT] Downloading DrumsRNN weights (~20 MB)…");
      const rnn = new mm.MusicRNN(CHECKPOINTS.drumRnn);
      await rnn.initialize();
      this.drumRnn = rnn;
      this.loaded.add(engine);
    } else if (engine === "magenta-vae" && !this.loaded.has(engine)) {
      onStatus("[INIT] Downloading MusicVAE weights (~45 MB)…");
      const vae = new mm.MusicVAE(CHECKPOINTS.musicVae);
      await vae.initialize();
      this.musicVae = vae;
      this.loaded.add(engine);
    }
    onStatus("[INIT] Model ready");
  }

  async generate(
    config: GeneratorConfig,
    features: AudioFeatures | null,
    onStatus: StatusCallback = console.log
  ): Promise<NoteEvent[]> {
    const mm = await this.getMM();
    const profile = config.seedFromAudio && features ? buildSingleTrackProfile(features) : null;
    const cond = profile
      ? deriveMagentaCondition(profile.meanVector, profile.dominantCluster)
      : {
          melodyTemperature: 0.6 + config.variation * 0.8,
          drumDensity: 1 + config.density * 3,
          latentBias: [0, 0] as [number, number],
          bpm: config.tempo,
          brightness: config.valence,
        };
    const bpm = config.seedFromAudio && features ? Math.round(features.tempo) : config.tempo;
    const steps = config.bars * 16;
    onStatus(`[RUN] ${config.engine} · bpm=${bpm} · temp=${cond.melodyTemperature.toFixed(2)}`);

    switch (config.engine) {
      case "magenta-melody":
        return this.melody(mm, steps, bpm, cond.melodyTemperature, onStatus);
      case "magenta-drums":
        return this.drums(mm, steps, bpm, cond.drumDensity, cond.melodyTemperature, onStatus);
      case "magenta-vae":
        return this.vae(mm, bpm, cond.melodyTemperature, onStatus);
      default:
        throw new Error(`Not a Magenta engine: ${config.engine}`);
    }
  }

  private async melody(
    mm: Awaited<ReturnType<MagentaEngine["getMM"]>>,
    steps: number,
    bpm: number,
    temperature: number,
    onStatus: StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.melodyRnn) throw new Error("MelodyRNN not initialised");
    const rnn = this.melodyRnn as InstanceType<typeof mm.MusicRNN>;
    const seed: MNoteSequence = {
      notes: [60, 62, 64, 67].map((pitch, i) => ({
        pitch,
        startTime: i * (60 / bpm) / 2,
        endTime: (i + 1) * (60 / bpm) / 2,
        velocity: 80,
      })),
      totalTime: 4 * (60 / bpm),
      tempos: [{ time: 0, qpm: bpm }],
      quantizationInfo: { stepsPerQuarter: 4 },
    };
    onStatus(`[MELODY] Continuing ${steps} steps…`);
    const out = (await rnn.continueSequence(
      mm.sequences.quantizeNoteSequence(seed as never, 4),
      steps,
      temperature
    )) as unknown as MNoteSequence;
    return toNoteEvents(out, "melody");
  }

  private async drums(
    mm: Awaited<ReturnType<MagentaEngine["getMM"]>>,
    steps: number,
    bpm: number,
    density: number,
    temperature: number,
    onStatus: StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.drumRnn) throw new Error("DrumsRNN not initialised");
    const rnn = this.drumRnn as InstanceType<typeof mm.MusicRNN>;
    const step = 60 / bpm / 2;
    const notes: MagentaNote[] = [
      { pitch: 36, startTime: 0, endTime: step, velocity: 100, isDrum: true },
      { pitch: 36, startTime: 4 * step, endTime: 5 * step, velocity: 100, isDrum: true },
    ];
    if (density >= 2) [2, 6].forEach((s) => notes.push({ pitch: 38, startTime: s * step, endTime: (s + 1) * step, velocity: 90, isDrum: true }));
    const seed: MNoteSequence = {
      notes,
      totalTime: 2 * (60 / bpm),
      tempos: [{ time: 0, qpm: bpm }],
      quantizationInfo: { stepsPerQuarter: 4 },
    };
    onStatus(`[DRUMS] Continuing ${steps} steps…`);
    const out = (await rnn.continueSequence(
      mm.sequences.quantizeNoteSequence(seed as never, 4),
      steps,
      temperature
    )) as unknown as MNoteSequence;
    return toNoteEvents(out, "drums");
  }

  private async vae(
    mm: Awaited<ReturnType<MagentaEngine["getMM"]>>,
    _bpm: number,
    temperature: number,
    onStatus: StatusCallback
  ): Promise<NoteEvent[]> {
    if (!this.musicVae) throw new Error("MusicVAE not initialised");
    const vae = this.musicVae as InstanceType<typeof mm.MusicVAE>;
    onStatus("[VAE] Sampling latent space…");
    const samples = (await vae.sample(2, temperature)) as unknown as MNoteSequence[];
    onStatus("[VAE] Interpolating…");
    const interp = (await vae.interpolate([samples[0] as never, samples[1] as never], 4)) as unknown as MNoteSequence[];
    const combined = mm.sequences.concatenate(interp as never) as unknown as MNoteSequence;
    return toNoteEvents(combined, "melody");
  }

  dispose(): void {
    [this.melodyRnn, this.musicVae, this.drumRnn].forEach((m) =>
      (m as { dispose?: () => void } | null)?.dispose?.()
    );
    this.melodyRnn = this.musicVae = this.drumRnn = null;
    this.loaded.clear();
  }
}

function toNoteEvents(seq: MNoteSequence, instrument: NoteEvent["instrument"]): NoteEvent[] {
  return (seq.notes ?? []).map((n) => ({
    pitch: n.pitch,
    startTime: n.startTime ?? 0,
    endTime: n.endTime ?? (n.startTime ?? 0) + 0.25,
    velocity: n.velocity ?? 80,
    instrument: n.isDrum ? "drums" : instrument,
  }));
}

export const magentaEngine = new MagentaEngine();
