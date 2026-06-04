/**
 * AudioDropzone.tsx
 *
 * Drag-and-drop (or click) an audio file. It is decoded and analysed
 * entirely in-browser (Web Audio FFT — nothing is uploaded) into an
 * AudioFeatures "DNA" vector that seeds the generator.
 */

import { useRef, useState, type CSSProperties } from "react";
import { motion } from "framer-motion";
import type { AudioFeatures } from "../types";
import { analyseAudioFile } from "../lib/audio-analysis";

const ACID = "#b8ff2c";

interface Props {
  onAnalysed: (features: AudioFeatures) => void;
}

export default function AudioDropzone({ onAnalysed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<AudioFeatures | null>(null);

  async function handleFile(file: File) {
    if (!file.type.startsWith("audio") && !/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name)) {
      setStatus("[ERR] Not an audio file");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const features = await analyseAudioFile(file, (m) => setStatus(m));
      setResult(features);
      onAnalysed(features);
    } catch (e) {
      setStatus(`[ERR] ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-card" style={panelSx}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.3em", color: "rgba(184,255,44,0.5)", marginBottom: 12 }}>
        // ANALYSE.TRACK
      </div>

      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        style={{
          border: `1px dashed ${dragging ? ACID : "rgba(184,255,44,0.25)"}`,
          borderRadius: 12,
          padding: "22px 16px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "rgba(184,255,44,0.06)" : "transparent",
          transition: "all 0.2s",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {busy ? (
          <motion.div
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ repeat: Infinity, duration: 1.1 }}
            style={{ fontFamily: "var(--mono)", fontSize: 10, color: ACID, letterSpacing: "0.1em" }}
          >
            ANALYSING…
          </motion.div>
        ) : (
          <>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "rgba(232,255,235,0.7)", marginBottom: 5, letterSpacing: "0.08em" }}>
              DROP AN AUDIO FILE
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "rgba(184,255,44,0.3)", letterSpacing: "0.12em" }}>
              mp3 · wav · m4a · flac — analysed locally, never uploaded
            </div>
          </>
        )}
      </div>

      {status && (
        <div style={{ marginTop: 10, fontFamily: '"SF Mono", monospace', fontSize: 8.5, color: "rgba(184,255,44,0.4)", lineHeight: 1.7, minHeight: 14 }}>
          {status}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 14px" }}>
          {([
            ["SOURCE", result.source ?? "—"],
            ["TEMPO", `${result.tempo} BPM`],
            ["ENERGY", `${Math.round(result.energy * 100)}%`],
            ["VALENCE", `${Math.round(result.valence * 100)}%`],
            ["DANCE", `${Math.round(result.danceability * 100)}%`],
            ["ACOUSTIC", `${Math.round(result.acousticness * 100)}%`],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: '"SF Mono", monospace', fontSize: 8, color: "rgba(184,255,44,0.3)", letterSpacing: "0.12em" }}>{k}</span>
              <span style={{ fontFamily: '"SF Mono", monospace', fontSize: 8, color: ACID, letterSpacing: "0.06em" }}>{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const panelSx: CSSProperties = {
  padding: "16px 18px",
  borderRadius: 16,
  border: "1px solid rgba(184,255,44,0.10)",
  background: "rgba(4,8,4,0.78)",
  backdropFilter: "blur(20px)",
  WebkitBackdropFilter: "blur(20px)",
  boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
  width: 320,
  boxSizing: "border-box",
};
