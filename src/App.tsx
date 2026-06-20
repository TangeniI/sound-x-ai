/**
 * App.tsx
 *
 * Root component. Owns shared state and wires the generative engines,
 * the synth, the audio analyser and every visual together.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import AudioReactiveBackground from "./components/AudioReactiveBackground";
import CharacterDisplay from "./components/CharacterDisplay";
import DNARadar from "./components/DNARadar";
import GeneratorPanel from "./components/GeneratorPanel";
import TrackTimeline from "./components/TrackTimeline";
import AudioDropzone from "./components/AudioDropzone";
import { generativeEngine, featuresFromConfig } from "./lib/generative-engine";
import { neuralRiff } from "./lib/neural-engine";
import { toneSynth } from "./lib/tone-synth";
import type { AudioFeatures, GeneratorConfig, Instrument, NoteEvent } from "./types";

/** Map a vertical click fraction (0=bottom, 1=top) to a pitch for a lane. */
function pitchForLane(inst: Instrument, frac: number): number {
  switch (inst) {
    case "drums": return frac > 0.66 ? 42 : frac > 0.33 ? 38 : 36; // hat / clap / kick
    case "bass": return 28 + Math.round(frac * 15);
    case "stab": return 48 + Math.round(frac * 19);
    default: return 60 + Math.round(frac * 24); // lead
  }
}

const LANE_ORDER: Instrument[] = ["lead", "stab", "bass", "drums"];

export default function App() {
  const [uploaded, setUploaded] = useState<AudioFeatures | null>(null);
  const [active, setActive] = useState<AudioFeatures | null>(null);
  const [notes, setNotes] = useState<NoteEvent[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [genStatus, setGenStatus] = useState("READY");
  const [synthPlaying, setSynthPlaying] = useState(false);
  const [synthProgressMs, setSynthProgressMs] = useState(0);
  const [beatCount, setBeatCount] = useState(0);
  const [neuralReady, setNeuralReady] = useState(false);

  const bpmRef = useRef(128);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // preload the trained riff model (falls back to Markov until ready)
  useEffect(() => { neuralRiff.load().then(() => setNeuralReady(neuralRiff.ready)); }, []);

  const handleBeat = useCallback(() => setBeatCount((c) => c + 1), []);

  const handleAnalysed = useCallback((f: AudioFeatures) => {
    setUploaded(f);
    setActive(f);
  }, []);

  /** Build a beats[] grid so the background/character pulse to the track. */
  function withBeats(f: AudioFeatures, durationSec: number): AudioFeatures {
    const beatSec = 60 / f.tempo;
    const beats = [];
    for (let t = 0; t < durationSec; t += beatSec) beats.push({ start: t, duration: beatSec });
    return { ...f, beats };
  }

  const handleGenerate = async (cfg: GeneratorConfig) => {
    setIsGenerating(true);
    setGenStatus("[INIT] Preparing engine…");
    handleStop();
    try {
      const seeded = cfg.seedFromAudio && uploaded ? uploaded : null;
      const bpm = seeded ? Math.round(seeded.tempo) : cfg.tempo;
      bpmRef.current = bpm;

      const generated = generativeEngine.generate(cfg, seeded, setGenStatus);
      setNotes(generated);

      const dna = seeded ?? featuresFromConfig(cfg);
      const durationSec = generated.length ? Math.max(...generated.map((n) => n.endTime)) : 8;
      setActive(withBeats(dna, durationSec));

      await toneSynth.init();
      toneSynth.setBPM(bpm);
      toneSynth.setBrightness(dna.brightness ?? dna.valence);
      toneSynth.schedule(generated);
      setGenStatus("[READY] Press ▶ PLAY to hear it");
    } catch (e) {
      setGenStatus(`[ERROR] ${(e as Error).message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStop = () => {
    toneSynth.stop();
    setSynthPlaying(false);
    setSynthProgressMs(0);
    clearInterval(timerRef.current);
  };

  const handlePlay = async () => {
    if (synthPlaying) { handleStop(); return; }
    await toneSynth.play();
    setSynthPlaying(true);
    setSynthProgressMs(0);
  };

  const handleExport = async () => {
    if (notes.length === 0) return;
    await toneSynth.downloadMidi(notes, bpmRef.current);
  };

  const handleExportWav = async () => {
    if (notes.length === 0) return;
    setGenStatus("[WAV] rendering offline…");
    try {
      await toneSynth.downloadWav(notes, bpmRef.current);
      setGenStatus("[WAV] downloaded ✓");
    } catch (e) {
      setGenStatus(`[WAV] ${(e as Error).message}`);
    }
  };

  const handleExportStems = async () => {
    if (notes.length === 0) return;
    try {
      await toneSynth.downloadStems(notes, bpmRef.current, setGenStatus);
    } catch (e) {
      setGenStatus(`[STEMS] ${(e as Error).message}`);
    }
  };

  // click-to-edit the piano roll: toggle a note at the clicked grid cell
  const handleEdit = (timeSec: number, laneIndex: number, pitchFrac: number) => {
    const instrument = LANE_ORDER[laneIndex];
    const stepSec = 60 / bpmRef.current / 4;
    const step = Math.max(0, Math.round(timeSec / stepSec));
    const tStart = step * stepSec;
    const idx = notes.findIndex(
      (n) => n.instrument === instrument && Math.abs(n.startTime - tStart) < stepSec * 0.6
    );
    let next: NoteEvent[];
    if (idx >= 0) {
      next = notes.filter((_, i) => i !== idx);
    } else {
      const dur = instrument === "drums" ? stepSec * 0.5 : stepSec * 1.4;
      next = [
        ...notes,
        { pitch: pitchForLane(instrument, pitchFrac), startTime: tStart, endTime: tStart + dur, velocity: 100, instrument },
      ].sort((a, b) => a.startTime - b.startTime);
    }
    setNotes(next);
    toneSynth.schedule(next);
  };

  // playback ticker → progress + beat-driven character
  useEffect(() => {
    if (!synthPlaying) { clearInterval(timerRef.current); return; }
    let lastBeat = -1;
    timerRef.current = setInterval(() => {
      const sec = toneSynth.getPositionSeconds();
      setSynthProgressMs(sec * 1000);
      const beat = Math.floor(sec / (60 / bpmRef.current));
      if (beat !== lastBeat) { lastBeat = beat; handleBeat(); }
      if (sec * 1000 >= totalDurationMs + 200) handleStop();
    }, 80);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synthPlaying]);

  const totalDurationMs = notes.length > 0 ? Math.max(...notes.map((n) => n.endTime)) * 1000 : 8000;

  return (
    <>
      <AudioReactiveBackground audioFeatures={active} isPlaying={synthPlaying} onBeat={handleBeat} progressMs={synthProgressMs} />

      <div className="app-shell" style={{ position: "relative", zIndex: 1, minHeight: "100vh", padding: "32px 40px", display: "flex", flexDirection: "column", gap: 24, fontFamily: "var(--sans)", color: "#e8ffe8", boxSizing: "border-box" }}>
        {/* header */}
        <header className="app-header" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.35em", color: "rgba(184,255,44,0.45)", marginBottom: 4 }}>
              // SOUND × AI
            </div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: "-0.02em", color: "#dcffc3" }}>
              Generative Audio Engine
            </h1>
            <p style={{ margin: "6px 0 0", fontSize: 11, fontFamily: "var(--mono)", letterSpacing: "0.12em", color: "rgba(232,255,235,0.3)", maxWidth: 520, lineHeight: 1.6 }}>
              Writes original techno tracks from a learned model of musical structure, not genre samples. Drive it with the controls, or drop in a track to clone its DNA.
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {notes.length > 0 && (
              <button onClick={handlePlay} style={{ padding: "9px 20px", border: "1px solid rgba(184,255,44,0.4)", borderRadius: 10, background: "rgba(184,255,44,0.08)", color: "#b8ff2c", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.25em", cursor: "pointer" }}>
                {synthPlaying ? "■ STOP" : "▶ PLAY"}
              </button>
            )}
            <a href="https://github.com/TangeniI/sound-x-ai" target="_blank" rel="noreferrer" style={{ padding: "9px 16px", border: "1px solid rgba(184,255,44,0.18)", borderRadius: 10, color: "rgba(184,255,44,0.5)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "0.2em", textDecoration: "none" }}>
              GITHUB ↗
            </a>
          </div>
        </header>

        {/* main grid */}
        <div className="main-grid" style={{ display: "grid", gridTemplateColumns: "320px 1fr 220px", gap: 24, alignItems: "start" }}>
          {/* col 1 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <GeneratorPanel features={uploaded} onGenerate={handleGenerate} onStop={handleStop} onExport={handleExport} onExportWav={handleExportWav} onExportStems={handleExportStems} hasTrack={notes.length > 0} neuralReady={neuralReady} isGenerating={isGenerating} status={genStatus} />
            <AudioDropzone onAnalysed={handleAnalysed} />
          </div>

          {/* col 2 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <TrackTimeline sequence={notes} isPlaying={synthPlaying} progressMs={synthProgressMs} durationMs={totalDurationMs} tempo={active?.tempo ?? 128} onEdit={handleEdit} />
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
              <CharacterDisplay beatCount={beatCount} isPlaying={synthPlaying} audioFeatures={active} />
            </div>
          </div>

          {/* col 3 */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <DNARadar audioFeatures={active} size={220} />
            {active && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "rgba(184,255,44,0.3)", letterSpacing: "0.18em", textAlign: "center", lineHeight: 1.9 }}>
                {active.source ?? "DNA"}<br />
                {Math.round(active.tempo)} BPM<br />
                ENERGY {Math.round(active.energy * 100)}%<br />
                VALENCE {Math.round(active.valence * 100)}%
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
