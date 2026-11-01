/**
 * AudioDropzone.tsx
 *
 * Drag-and-drop (or pick) an audio file. It is decoded and analysed entirely in
 * the browser, nothing is uploaded, and the result fills in the controls.
 */

import { useRef, useState } from "react";
import type { AudioFeatures } from "../types";

const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

interface Props {
  onFile: (file: File, onStatus: (m: string) => void) => Promise<AudioFeatures>;
}

export default function AudioDropzone({ onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<AudioFeatures | null>(null);

  async function handle(file: File) {
    if (!file.type.startsWith("audio") && !/\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(file.name)) {
      setStatus("That isn't an audio file");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      setResult(await onFile(file, setStatus));
    } catch {
      setStatus("Couldn't read that file. Try an MP3 or WAV.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ""; // so the same file can be picked again
    }
  }

  return (
    <section className="panel drop" aria-label="Analyse a track">
      <div className="panel-head"><h2>Match a track</h2></div>
      <label
        className={dragging ? "dropzone over" : "dropzone"}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void handle(f);
        }}
      >
        <input ref={input} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handle(f); }} />
        <strong>{busy ? "Analysing…" : "Drop an audio file"}</strong>
        <span>Sets tempo, key, energy and mood to match. Stays on your device.</span>
      </label>
      {status && <p className="drop-status" role="status">{status}</p>}
      {result && (
        <>
          <dl className="drop-result">
            <div><dt>Key</dt><dd>{KEYS[result.rootPitch ?? 0]} {result.mode}</dd></div>
            <div><dt>Tempo</dt><dd>{result.tempo} BPM</dd></div>
            <div><dt>Energy</dt><dd>{Math.round(result.energy * 100)}%</dd></div>
            <div><dt>Bright</dt><dd>{Math.round((result.brightness ?? 0) * 100)}%</dd></div>
          </dl>
          <p className="drop-status">The key is an estimate. Change it above if it clashes.</p>
        </>
      )}
    </section>
  );
}
