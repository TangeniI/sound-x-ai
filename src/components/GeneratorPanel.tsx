/**
 * GeneratorPanel.tsx
 *
 * Primary UI for Sound×AI music generation.
 * Layout:
 *   ┌──────────────────────────────────┐
 *   │  // GENERATOR.EXE               │
 *   │  [model selector]                │
 *   │  [conditioning sliders]          │
 *   │  [GENERATE] [STOP] [EXPORT]      │
 *   │  [status log]                    │
 *   └──────────────────────────────────┘
 *
 * Props:
 *   audioFeatures  — pre-filled conditioning from Spotify track
 *   onGenerate     — called with GeneratorConfig; parent owns Magenta engine
 *   onStop         — stop current generation
 *   onExport       — export MIDI/audio
 *   isGenerating   — whether engine is running
 *   status         — status message from engine
 */

import { useState, useEffect, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface AudioFeatures {
  tempo:        number;
  energy:       number;
  valence:      number;
  danceability: number;
  acousticness: number;
}

export interface GeneratorConfig {
  model:       "melody" | "drums" | "vae";
  temperature: number;
  steps:       number;
  tempo:       number;
  energy:      number;
  valence:     number;
  seedFromSpotify: boolean;
}

interface Props {
  audioFeatures?: AudioFeatures | null;
  onGenerate?:   (cfg: GeneratorConfig) => void;
  onStop?:       () => void;
  onExport?:     () => void;
  isGenerating?: boolean;
  status?:       string;
}

/* ─── helpers ─────────────────────────────────────────────────────────── */

const ACID = "#b8ff2c";

const MODEL_OPTIONS = [
  { id: "melody" as const, label: "MELODY RNN",  desc: "Melodic sequences via LSTM" },
  { id: "drums"  as const, label: "DRUM RNN",    desc: "Rhythmic patterns from danceability" },
  { id: "vae"    as const, label: "MUSIC VAE",   desc: "Latent space interpolation" },
];

interface SliderProps {
  label:    string;
  value:    number;
  min?:     number;
  max?:     number;
  step?:    number;
  onChange: (v: number) => void;
  format?:  (v: number) => string;
}

function Slider({ label, value, min = 0, max = 1, step = 0.01, onChange, format }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={labelSx}>{label}</span>
        <span style={{ ...labelSx, color: ACID, opacity: 1 }}>
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <div style={{ position: "relative", height: 3, background: "rgba(184,255,44,0.10)", borderRadius: 2 }}>
        {/* filled track */}
        <div style={{
          position:     "absolute",
          left:         0,
          top:          0,
          height:       "100%",
          width:        `${pct}%`,
          background:   ACID,
          borderRadius: 2,
          transition:   "width 0.1s",
        }} />
        {/* native range (invisible but functional) */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{
            position:  "absolute",
            inset:     "-6px 0",
            opacity:   0,
            cursor:    "pointer",
            width:     "100%",
          }}
        />
        {/* thumb */}
        <div style={{
          position:   "absolute",
          top:        "50%",
          left:       `${pct}%`,
          transform:  "translate(-50%, -50%)",
          width:      10,
          height:     10,
          borderRadius: "50%",
          background: ACID,
          boxShadow:  `0 0 8px rgba(184,255,44,0.6)`,
          pointerEvents: "none",
        }} />
      </div>
    </div>
  );
}

/* ─── main component ─────────────────────────────────────────────────── */

export default function GeneratorPanel({
  audioFeatures,
  onGenerate,
  onStop,
  onExport,
  isGenerating = false,
  status = "READY",
}: Props) {
  const [model,       setModel]       = useState<GeneratorConfig["model"]>("melody");
  const [temperature, setTemperature] = useState(0.9);
  const [steps,       setSteps]       = useState(128);
  const [tempo,       setTempo]       = useState(138);
  const [energy,      setEnergy]      = useState(0.6);
  const [valence,     setValence]     = useState(0.5);
  const [seedSpotify, setSeedSpotify] = useState(true);
  const [logLines,    setLogLines]    = useState<string[]>(["[READY] Awaiting generation..."]);

  // Pre-fill from Spotify when track changes
  useEffect(() => {
    if (!audioFeatures) return;
    setTempo(Math.round(audioFeatures.tempo));
    setEnergy(parseFloat(audioFeatures.energy.toFixed(2)));
    setValence(parseFloat(audioFeatures.valence.toFixed(2)));
    addLog(`[SPOTIFY] Loaded: tempo=${Math.round(audioFeatures.tempo)} energy=${audioFeatures.energy.toFixed(2)}`);
  }, [audioFeatures]);

  // Mirror status into log
  useEffect(() => {
    if (status !== "READY") addLog(`[ENGINE] ${status}`);
  }, [status]);

  function addLog(line: string) {
    setLogLines((prev) => [...prev.slice(-6), line]);
  }

  function handleGenerate() {
    const cfg: GeneratorConfig = {
      model,
      temperature,
      steps,
      tempo,
      energy,
      valence,
      seedFromSpotify: seedSpotify,
    };
    addLog(`[RUN] model=${model.toUpperCase()} temp=${temperature.toFixed(2)} steps=${steps}`);
    onGenerate?.(cfg);
  }

  return (
    <div style={panelSx}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.3em", color: "rgba(184,255,44,0.5)" }}>
          // GENERATOR.EXE
        </span>
        <div style={{
          width:        6,
          height:       6,
          borderRadius: "50%",
          background:   isGenerating ? ACID : "rgba(184,255,44,0.25)",
          boxShadow:    isGenerating ? `0 0 10px ${ACID}` : "none",
          animation:    isGenerating ? "genPulse 0.8s ease-in-out infinite alternate" : "none",
        }} />
      </div>

      {/* model selector */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ ...labelSx, marginBottom: 8 }}>MODEL</div>
        <div style={{ display: "flex", gap: 6 }}>
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m.id}
              onClick={() => setModel(m.id)}
              style={{
                flex:        1,
                padding:     "7px 4px",
                border:      `1px solid ${model === m.id ? ACID : "rgba(184,255,44,0.12)"}`,
                borderRadius: 8,
                background:   model === m.id ? "rgba(184,255,44,0.08)" : "transparent",
                cursor:       "pointer",
                transition:   "all 0.2s",
              }}
            >
              <div style={{
                fontFamily:    "var(--mono)",
                fontSize:      7.5,
                letterSpacing: "0.18em",
                color:         model === m.id ? ACID : "rgba(184,255,44,0.30)",
                marginBottom:  3,
              }}>
                {m.label}
              </div>
              <div style={{
                fontFamily: "var(--mono)",
                fontSize:   6.5,
                color:      "rgba(184,255,44,0.18)",
                lineHeight: 1.4,
              }}>
                {m.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* conditioning sliders */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}>
        <Slider label="TEMPERATURE" value={temperature} min={0.1} max={1.5} onChange={setTemperature} />
        <Slider label="STEPS"       value={steps}       min={32}  max={512} step={32} onChange={setSteps} format={(v) => String(v)} />
        <Slider label="TEMPO (BPM)" value={tempo}       min={115} max={185} step={1}  onChange={setTempo} format={(v) => `${v} BPM`} />
        <Slider label="ENERGY"      value={energy}      onChange={setEnergy} />
        <Slider label="VALENCE"     value={valence}     onChange={setValence} />
      </div>

      {/* spotify seed toggle */}
      <div
        onClick={() => setSeedSpotify((p) => !p)}
        style={{
          display:       "flex",
          alignItems:    "center",
          gap:           8,
          cursor:        "pointer",
          marginBottom:  18,
          userSelect:    "none",
        }}
      >
        <div style={{
          width:        28,
          height:       14,
          borderRadius: 7,
          background:   seedSpotify ? "rgba(184,255,44,0.2)" : "rgba(184,255,44,0.06)",
          border:       `1px solid ${seedSpotify ? ACID : "rgba(184,255,44,0.15)"}`,
          position:     "relative",
          transition:   "all 0.2s",
        }}>
          <motion.div
            animate={{ x: seedSpotify ? 14 : 2 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            style={{
              position:     "absolute",
              top:          2,
              width:        9,
              height:       9,
              borderRadius: "50%",
              background:   seedSpotify ? ACID : "rgba(184,255,44,0.3)",
            }}
          />
        </div>
        <span style={{ ...labelSx }}>SEED FROM SPOTIFY TRACK</span>
      </div>

      {/* action buttons */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={handleGenerate}
          disabled={isGenerating}
          style={{
            flex:         1,
            padding:      "10px 0",
            background:   isGenerating ? "rgba(184,255,44,0.06)" : "rgba(184,255,44,0.12)",
            border:       `1px solid ${isGenerating ? "rgba(184,255,44,0.15)" : ACID}`,
            borderRadius: 10,
            cursor:       isGenerating ? "not-allowed" : "pointer",
            fontFamily:   "var(--mono)",
            fontSize:     9.5,
            letterSpacing: "0.28em",
            color:        isGenerating ? "rgba(184,255,44,0.35)" : ACID,
            transition:   "all 0.2s",
          }}
        >
          {isGenerating ? "GENERATING..." : "▶ GENERATE"}
        </motion.button>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={onStop}
          disabled={!isGenerating}
          style={{
            padding:      "10px 14px",
            background:   "transparent",
            border:       "1px solid rgba(255,80,80,0.25)",
            borderRadius: 10,
            cursor:       isGenerating ? "pointer" : "not-allowed",
            fontFamily:   "var(--mono)",
            fontSize:     9.5,
            letterSpacing: "0.2em",
            color:        isGenerating ? "rgba(255,100,100,0.7)" : "rgba(255,100,100,0.2)",
            transition:   "all 0.2s",
          }}
        >
          ■ STOP
        </motion.button>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={onExport}
          style={{
            padding:      "10px 14px",
            background:   "transparent",
            border:       "1px solid rgba(184,255,44,0.18)",
            borderRadius: 10,
            cursor:       "pointer",
            fontFamily:   "var(--mono)",
            fontSize:     9.5,
            letterSpacing: "0.2em",
            color:        "rgba(184,255,44,0.45)",
            transition:   "all 0.2s",
          }}
        >
          ↓ MIDI
        </motion.button>
      </div>

      {/* status log */}
      <div style={{
        background:   "rgba(0,0,0,0.4)",
        border:       "1px solid rgba(184,255,44,0.06)",
        borderRadius: 8,
        padding:      "10px 12px",
        fontFamily:   '"SF Mono", "Fira Code", monospace',
        fontSize:     9,
        color:        "rgba(184,255,44,0.45)",
        lineHeight:   1.8,
        minHeight:    80,
      }}>
        <AnimatePresence initial={false}>
          {logLines.map((line, i) => (
            <motion.div
              key={line + i}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
            >
              {line}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <style>{`
        @keyframes genPulse {
          from { opacity: 0.5; }
          to   { opacity: 1;   }
        }
      `}</style>
    </div>
  );
}

/* ─── shared styles ─────────────────────────────────────────────────── */

const panelSx: CSSProperties = {
  padding:          "18px 20px",
  borderRadius:     16,
  border:           "1px solid rgba(184,255,44,0.10)",
  background:       "rgba(4,8,4,0.78)",
  backdropFilter:   "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow:        "0 24px 80px rgba(0,0,0,0.55)",
  width:            320,
  fontFamily:       "var(--sans)",
};

const labelSx: CSSProperties = {
  fontFamily:    '"SF Mono", "Fira Code", monospace',
  fontSize:      8.5,
  letterSpacing: "0.22em",
  color:         "rgba(184,255,44,0.35)",
  textTransform: "uppercase" as const,
};