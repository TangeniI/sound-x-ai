/**
 * GeneratorPanel.tsx
 *
 * Primary control surface for the generator. Lets the user pick an engine
 * (instant bespoke vs. Magenta deep models), shape the conditioning
 * "DNA" via sliders, optionally seed from an analysed upload, and fire
 * GENERATE / STOP / EXPORT.
 */

import { useState, useEffect, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AudioFeatures, GeneratorConfig, StyleId } from "../types";
import { shareURL, parseConfigFromURL, saveConfig, loadSavedConfig } from "../lib/share";

export type { GeneratorConfig };

interface Props {
  features?: AudioFeatures | null;
  onGenerate?: (cfg: GeneratorConfig) => void;
  onStop?: () => void;
  onExport?: () => void;       // MIDI
  onExportWav?: () => void;    // rendered WAV
  onExportStems?: () => void;  // per-instrument WAV stems
  hasTrack?: boolean;
  neuralReady?: boolean;
  isGenerating?: boolean;
  status?: string;
}

const ACID = "#b8ff2c";
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const STYLES: { id: StyleId; label: string; desc: string }[] = [
  { id: "driving", label: "DRIVING", desc: "rolling bass · peak-time" },
  { id: "hypnotic", label: "HYPNOTIC", desc: "minimal · deep groove" },
  { id: "acid", label: "ACID", desc: "303 line · squelch" },
  { id: "melodic", label: "MELODIC", desc: "pads · melodic techno" },
];

/* ─── slider ───────────────────────────────────────────────────────── */

interface SliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
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
        <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct}%`, background: ACID, borderRadius: 2, transition: "width 0.1s" }} />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{ position: "absolute", inset: "-6px 0", opacity: 0, cursor: "pointer", width: "100%" }}
        />
        <div style={{ position: "absolute", top: "50%", left: `${pct}%`, transform: "translate(-50%, -50%)", width: 10, height: 10, borderRadius: "50%", background: ACID, boxShadow: "0 0 8px rgba(184,255,44,0.6)", pointerEvents: "none" }} />
      </div>
    </div>
  );
}

/* ─── main ─────────────────────────────────────────────────────────── */

export default function GeneratorPanel({
  features,
  onGenerate,
  onStop,
  onExport,
  onExportWav,
  onExportStems,
  hasTrack = false,
  neuralReady = false,
  isGenerating = false,
  status = "READY",
}: Props) {
  // precedence: shared link > last-used (localStorage) > defaults
  const [urlCfg] = useState(parseConfigFromURL);
  const [saved] = useState(loadSavedConfig);
  const pick = <K extends keyof typeof urlCfg>(k: K, dflt: NonNullable<(typeof urlCfg)[K]>) =>
    (urlCfg[k] ?? saved[k] ?? dflt) as NonNullable<(typeof urlCfg)[K]>;
  const [style, setStyle] = useState<StyleId>(pick("style", "driving"));
  const [tempo, setTempo] = useState(pick("tempo", 128));
  const [bars, setBars] = useState(pick("bars", 8));
  const [energy, setEnergy] = useState(pick("energy", 0.7));
  const [valence, setValence] = useState(pick("valence", 0.45));
  const [density, setDensity] = useState(pick("density", 0.65));
  const [variation, setVariation] = useState(pick("variation", 0.35));
  const [rootPitch, setRootPitch] = useState(pick("rootPitch", 9)); // A
  const [seedFromAudio, setSeedFromAudio] = useState(false);
  const [shared, setShared] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([
    Object.keys(urlCfg).length ? "[LINK] loaded a shared track recipe — press GENERATE" : "[READY] In-house engine warm. Awaiting generation.",
  ]);

  // when a track is analysed, prefill + offer to seed from it
  useEffect(() => {
    if (!features) return;
    setTempo(Math.round(features.tempo));
    setEnergy(parseFloat(features.energy.toFixed(2)));
    setValence(parseFloat(features.valence.toFixed(2)));
    setDensity(parseFloat(features.danceability.toFixed(2)));
    if (features.rootPitch != null) setRootPitch(features.rootPitch);
    setSeedFromAudio(true);
    addLog(`[ANALYSIS] ${features.source ?? "TRACK"} → ${NOTES[features.rootPitch ?? 0]} ${features.mode ?? ""} · ${Math.round(features.tempo)} BPM`);
  }, [features]);

  useEffect(() => {
    if (status !== "READY") addLog(`${status}`);
  }, [status]);

  // remember the last-used settings across visits
  useEffect(() => {
    saveConfig({ style, bars, tempo, energy, valence, density, variation, rootPitch });
  }, [style, bars, tempo, energy, valence, density, variation, rootPitch]);

  function addLog(line: string) {
    setLogLines((prev) => [...prev.slice(-6), line]);
  }

  function handleGenerate() {
    const cfg: GeneratorConfig = {
      style,
      bars,
      tempo,
      energy,
      valence,
      density,
      variation,
      rootPitch,
      seedFromAudio: seedFromAudio && !!features,
    };
    addLog(`[RUN] ${style.toUpperCase()} · ${NOTES[rootPitch]} · ${bars} bars`);
    onGenerate?.(cfg);
  }

  function handleShare() {
    const cfg: GeneratorConfig = { style, bars, tempo, energy, valence, density, variation, rootPitch, seedFromAudio: false };
    const url = shareURL(cfg);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setShared(true);
        setTimeout(() => setShared(false), 1600);
      }).catch(() => {});
    }
  }

  return (
    <div className="panel-card" style={panelSx}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.3em", color: "rgba(184,255,44,0.5)" }}>
          // GENERATOR.EXE
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span title="GRU riff model trained in NumPy, running in-browser" style={{
            fontFamily: "var(--mono)", fontSize: 7, letterSpacing: "0.12em",
            padding: "2px 6px", borderRadius: 5,
            border: `1px solid rgba(184,255,44,${neuralReady ? 0.35 : 0.12})`,
            color: `rgba(184,255,44,${neuralReady ? 0.7 : 0.3})`,
          }}>
            {neuralReady ? "◉ NEURAL" : "○ NEURAL…"}
          </span>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: isGenerating ? ACID : "rgba(184,255,44,0.25)", boxShadow: isGenerating ? `0 0 10px ${ACID}` : "none", animation: isGenerating ? "genPulse 0.8s ease-in-out infinite alternate" : "none" }} />
        </div>
      </div>

      {/* style selector */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ ...labelSx, marginBottom: 8 }}>STYLE</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {STYLES.map((m) => (
            <button
              key={m.id}
              onClick={() => setStyle(m.id)}
              style={{
                padding: "7px 8px",
                textAlign: "left",
                border: `1px solid ${style === m.id ? ACID : "rgba(184,255,44,0.12)"}`,
                borderRadius: 8,
                background: style === m.id ? "rgba(184,255,44,0.08)" : "transparent",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              <div style={{ fontFamily: "var(--mono)", fontSize: 8.5, letterSpacing: "0.14em", color: style === m.id ? ACID : "rgba(184,255,44,0.32)", marginBottom: 3 }}>
                {m.label}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 6.5, color: "rgba(184,255,44,0.22)", lineHeight: 1.4 }}>
                {m.desc}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* sliders */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 14 }}>
        <Slider label="TEMPO" value={tempo} min={90} max={175} step={1} onChange={setTempo} format={(v) => `${v} BPM`} />
        <Slider label="LENGTH" value={bars} min={4} max={16} step={4} onChange={setBars} format={(v) => `${v} bars`} />
        <Slider label="ENERGY" value={energy} onChange={setEnergy} />
        <Slider label="VALENCE (MOOD)" value={valence} onChange={setValence} />
        <Slider label="DENSITY" value={density} onChange={setDensity} />
        <Slider label="VARIATION" value={variation} onChange={setVariation} />
      </div>

      {/* root key picker */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ ...labelSx, marginBottom: 6 }}>KEY</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {NOTES.map((n, i) => (
            <button
              key={n}
              onClick={() => setRootPitch(i)}
              style={{
                flex: "1 1 14%",
                padding: "5px 0",
                fontFamily: "var(--mono)",
                fontSize: 8,
                border: `1px solid ${rootPitch === i ? ACID : "rgba(184,255,44,0.1)"}`,
                background: rootPitch === i ? "rgba(184,255,44,0.12)" : "transparent",
                color: rootPitch === i ? ACID : "rgba(184,255,44,0.3)",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* seed toggle */}
      <div
        onClick={() => features && setSeedFromAudio((p) => !p)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: features ? "pointer" : "not-allowed", marginBottom: 16, userSelect: "none", opacity: features ? 1 : 0.4 }}
      >
        <div style={{ width: 28, height: 14, borderRadius: 7, background: seedFromAudio ? "rgba(184,255,44,0.2)" : "rgba(184,255,44,0.06)", border: `1px solid ${seedFromAudio ? ACID : "rgba(184,255,44,0.15)"}`, position: "relative", transition: "all 0.2s" }}>
          <motion.div animate={{ x: seedFromAudio ? 14 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 30 }} style={{ position: "absolute", top: 2, width: 9, height: 9, borderRadius: "50%", background: seedFromAudio ? ACID : "rgba(184,255,44,0.3)" }} />
        </div>
        <span style={labelSx}>{features ? "SEED FROM UPLOADED TRACK" : "UPLOAD A TRACK TO SEED"}</span>
      </div>

      {/* actions */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={handleGenerate} disabled={isGenerating}
          style={{ flex: 1, padding: "10px 0", background: isGenerating ? "rgba(184,255,44,0.06)" : "rgba(184,255,44,0.12)", border: `1px solid ${isGenerating ? "rgba(184,255,44,0.15)" : ACID}`, borderRadius: 10, cursor: isGenerating ? "not-allowed" : "pointer", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.28em", color: isGenerating ? "rgba(184,255,44,0.35)" : ACID, transition: "all 0.2s" }}>
          {isGenerating ? "GENERATING…" : "▶ GENERATE"}
        </motion.button>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={onStop}
          style={{ padding: "10px 14px", background: "transparent", border: "1px solid rgba(255,80,80,0.25)", borderRadius: 10, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.2em", color: "rgba(255,100,100,0.7)", transition: "all 0.2s" }}>
          ■ STOP
        </motion.button>
      </div>

      {/* share */}
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.97 }}
        onClick={handleShare}
        style={{
          width: "100%", padding: "8px 0", marginBottom: 8,
          background: shared ? "rgba(184,255,44,0.1)" : "transparent",
          border: `1px solid rgba(184,255,44,${shared ? 0.4 : 0.18})`,
          borderRadius: 9, cursor: "pointer", fontFamily: "var(--mono)",
          fontSize: 8.5, letterSpacing: "0.18em",
          color: shared ? ACID : "rgba(184,255,44,0.5)", transition: "all 0.2s",
        }}
      >
        {shared ? "✓ LINK COPIED — share your track" : "⧉ SHARE THIS TRACK"}
      </motion.button>

      {/* export row */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {([
          ["↓ WAV", onExportWav],
          ["↓ STEMS", onExportStems],
          ["↓ MIDI", onExport],
        ] as [string, (() => void) | undefined][]).map(([label, fn]) => (
          <motion.button
            key={label}
            whileHover={hasTrack ? { scale: 1.03 } : undefined}
            whileTap={hasTrack ? { scale: 0.96 } : undefined}
            onClick={fn}
            disabled={!hasTrack}
            style={{
              flex: 1,
              padding: "8px 0",
              background: "transparent",
              border: `1px solid rgba(184,255,44,${hasTrack ? 0.25 : 0.08})`,
              borderRadius: 9,
              cursor: hasTrack ? "pointer" : "not-allowed",
              fontFamily: "var(--mono)",
              fontSize: 8.5,
              letterSpacing: "0.16em",
              color: `rgba(184,255,44,${hasTrack ? 0.6 : 0.2})`,
              transition: "all 0.2s",
            }}
          >
            {label}
          </motion.button>
        ))}
      </div>

      {/* log */}
      <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(184,255,44,0.06)", borderRadius: 8, padding: "10px 12px", fontFamily: '"SF Mono", "Fira Code", monospace', fontSize: 9, color: "rgba(184,255,44,0.45)", lineHeight: 1.8, minHeight: 80 }}>
        <AnimatePresence initial={false}>
          {logLines.map((line, i) => (
            <motion.div key={line + i} initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
              {line}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <style>{`@keyframes genPulse { from { opacity: 0.5; } to { opacity: 1; } }`}</style>
    </div>
  );
}

const panelSx: CSSProperties = {
  padding: "18px 20px",
  borderRadius: 16,
  border: "1px solid rgba(184,255,44,0.10)",
  background: "rgba(4,8,4,0.78)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
  width: 320,
  fontFamily: "var(--sans)",
};

const labelSx: CSSProperties = {
  fontFamily: '"SF Mono", "Fira Code", monospace',
  fontSize: 8.5,
  letterSpacing: "0.22em",
  color: "rgba(184,255,44,0.35)",
  textTransform: "uppercase" as const,
};
