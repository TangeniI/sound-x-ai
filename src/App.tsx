/**
 * App.tsx
 *
 * Root component for Sound×AI.
 * Owns all shared state and wires every lib + component together.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import AudioReactiveBackground from "./components/AudioReactiveBackground";
import type { AudioFeatures, NoteEvent as NoteEventType } from "./types";
import CharacterDisplay                               from "./components/CharacterDisplay";
import DNARadar                                       from "./components/DNARadar";
import GeneratorPanel, { type GeneratorConfig }       from "./components/GeneratorPanel";
import TrackTimeline                                  from "./components/TrackTimeline";
import NowPlaying                                     from "./components/NowPlaying";
import { magentaEngine }                              from "./lib/magenta-engine";
import { toneSynth }                                  from "./lib/tone-synth";
import { buildSingleTrackProfile }                    from "./lib/taste-profile";

export default function App() {
  const [audioFeatures,  setAudioFeatures]  = useState<AudioFeatures | null>(null);
  const [spotifyPlaying, setSpotifyPlaying] = useState(false);
  const [progressMs,     setProgressMs]     = useState(0);
  const [beatCount,      setBeatCount]      = useState(0);
  const [notes,          setNotes]          = useState<NoteEventType[]>([]);
  const [isGenerating,   setIsGenerating]   = useState(false);
  const [genStatus,      setGenStatus]      = useState("READY");
  const [synthPlaying,   setSynthPlaying]   = useState(false);
  const [synthProgressMs, setSynthProgressMs] = useState(0);
  const synthTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const handleBeat = useCallback(() => setBeatCount((c) => c + 1), []);

  const handleAudioFeatures = useCallback((f: AudioFeatures | null) => {
    setAudioFeatures(f);
  }, []);

  const handlePlayback = useCallback(
    (p: { progressMs: number; isPlaying: boolean }) => {
      setSpotifyPlaying(p.isPlaying);
      setProgressMs(p.progressMs);
    },
    []
  );

  const handleGenerate = async (cfg: GeneratorConfig) => {
    setIsGenerating(true);
    setGenStatus("Initialising model…");
    try {
      await magentaEngine.init(cfg.model, setGenStatus);
      const profile = audioFeatures
        ? buildSingleTrackProfile(audioFeatures)
        : null;
      const generated = await magentaEngine.generate(cfg, profile, setGenStatus);
      setNotes(generated);

      await toneSynth.init();
      toneSynth.setBPM(cfg.tempo);
      if (audioFeatures) toneSynth.setBrightness(audioFeatures.valence ?? 0.5);
      toneSynth.schedule(generated);
      setGenStatus("READY — press ▶ to play");
    } catch (e) {
      setGenStatus(`ERROR: ${(e as Error).message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStop = () => {
    toneSynth.stop();
    setSynthPlaying(false);
    clearInterval(synthTimerRef.current);
  };

  const handleExport = async () => {
    if (notes.length === 0) return;
    const bpm = audioFeatures ? Math.round(audioFeatures.tempo ?? 120) : 120;
    await toneSynth.downloadMidi(notes, bpm);
  };

  // Rough synth progress ticker (Tone.js transport doesn't expose an event)
  useEffect(() => {
    if (synthPlaying) {
      synthTimerRef.current = setInterval(() => {
        setSynthProgressMs(toneSynth.getPositionSeconds() * 1000);
      }, 250);
    } else {
      clearInterval(synthTimerRef.current);
    }
    return () => clearInterval(synthTimerRef.current);
  }, [synthPlaying]);

  const totalDurationMs = notes.length > 0
    ? Math.max(...notes.map((n) => n.endTime)) * 1000
    : 8000;

  return (
    <>
      <AudioReactiveBackground
        audioFeatures={audioFeatures}
        isPlaying={spotifyPlaying}
        onBeat={handleBeat}
        progressMs={progressMs}
      />

      <div style={{
        position:   "relative",
        zIndex:     1,
        minHeight:  "100vh",
        padding:    "32px 40px",
        display:    "flex",
        flexDirection: "column",
        gap:        28,
        fontFamily: "var(--sans)",
        color:      "#e8ffe8",
        boxSizing:  "border-box",
      }}>

        {/* ── header ────────────────────────────────────────────────── */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{
              fontFamily:    "var(--mono)",
              fontSize:      9,
              letterSpacing: "0.35em",
              color:         "rgba(184,255,44,0.45)",
              marginBottom:  4,
            }}>
              // TECHNO × AI
            </div>
            <h1 style={{
              margin:      0,
              fontSize:    22,
              fontWeight:  800,
              letterSpacing: "-0.02em",
              color:       "#dcffc3",
            }}>
              Floor DNA Generator
            </h1>
            <p style={{
              margin:      "6px 0 0",
              fontSize:    11,
              fontFamily:  "var(--mono)",
              letterSpacing: "0.14em",
              color:       "rgba(232,255,235,0.28)",
              maxWidth:    420,
              lineHeight:  1.5,
            }}>
              Trained on your listening history · 4/4 tension and release, not genre paint-by-numbers
            </p>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {/* play generated audio button */}
            {notes.length > 0 && (
              <button
                onClick={async () => {
                  if (synthPlaying) {
                    handleStop();
                  } else {
                    await toneSynth.play();
                    setSynthPlaying(true);
                    setSynthProgressMs(0);
                  }
                }}
                style={{
                  padding:      "8px 18px",
                  border:       "1px solid rgba(184,255,44,0.4)",
                  borderRadius: 10,
                  background:   "rgba(184,255,44,0.08)",
                  color:        "#b8ff2c",
                  fontFamily:   "var(--mono)",
                  fontSize:     9,
                  letterSpacing: "0.25em",
                  cursor:       "pointer",
                }}
              >
                {synthPlaying ? "■ STOP" : "▶ PLAY GENERATED"}
              </button>
            )}
          </div>
        </header>

        {/* ── main grid ─────────────────────────────────────────────── */}
        <div style={{
          display:             "grid",
          gridTemplateColumns: "320px 1fr 220px",
          gridTemplateRows:    "auto auto",
          gap:                 24,
          alignItems:          "start",
        }}>

          {/* col 1: generator + now playing */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <GeneratorPanel
              audioFeatures={audioFeatures}
              onGenerate={handleGenerate}
              onStop={handleStop}
              onExport={handleExport}
              isGenerating={isGenerating}
              status={genStatus}
            />
            <NowPlaying onAudioFeatures={handleAudioFeatures} onPlayback={handlePlayback} />
          </div>

          {/* col 2: timeline (full width) + character */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <TrackTimeline
              sequence={notes}
              isPlaying={synthPlaying}
              progressMs={synthProgressMs}
              durationMs={totalDurationMs}
              tempo={audioFeatures?.tempo ?? 120}
            />
            <div style={{ display: "flex", justifyContent: "center", paddingTop: 8 }}>
              <CharacterDisplay
                beatCount={beatCount}
                isPlaying={spotifyPlaying}
                audioFeatures={audioFeatures}
              />
            </div>
          </div>

          {/* col 3: DNA radar */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <DNARadar audioFeatures={audioFeatures} size={220} />
            {audioFeatures && (
              <div style={{
                fontFamily:    "var(--mono)",
                fontSize:      8.5,
                color:         "rgba(184,255,44,0.30)",
                letterSpacing: "0.18em",
                textAlign:     "center",
                lineHeight:    1.9,
              }}>
                {Math.round(audioFeatures.tempo)} BPM<br />
                ENERGY {Math.round(audioFeatures.energy * 100)}%<br />
                VALENCE {Math.round(audioFeatures.valence * 100)}%
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}