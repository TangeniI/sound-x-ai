/**
 * Transport.tsx
 *
 * The bar that stays on screen: play, new take, position, loop, level, export.
 * Position and meters are drawn from the audio clock in their own loop, so the
 * rest of the app doesn't re-render as the track plays.
 */

import { useEffect, useRef, useState } from "react";
import type { Studio } from "../hooks/useStudio";
import { player } from "../lib/audio/player";

const SECTION_NAMES: Record<string, string> = {
  intro: "Intro", groove: "Groove", riff: "Riff", break: "Break", build: "Build", drop: "Drop", outro: "Outro",
};

const LOOP_LABEL = { track: "Loop track", section: "Loop section", off: "Loop off" };

export default function Transport({ studio }: { studio: Studio }) {
  const { track, ready, loadProgress, playing, status, busy, loop, copied } = studio;
  const [menuOpen, setMenuOpen] = useState(false);
  const bar = useRef<HTMLSpanElement>(null);
  const section = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      if (!track) return;
      const pos = Math.min(player.position(), track.durationSec);
      const barSec = track.stepSec * 16;
      const b = Math.floor(pos / barSec);
      const beat = Math.floor((pos / barSec - b) * 4);
      if (bar.current) bar.current.textContent = `${b + 1}.${beat + 1}`;
      const s = track.sections.find((x) => b >= x.startBar && b < x.startBar + x.bars);
      if (section.current && s) section.current.textContent = SECTION_NAMES[s.kind];
      if (fill.current) fill.current.style.transform = `scaleX(${pos / track.durationSec})`;
      if (meter.current) meter.current.style.transform = `scaleX(${playing ? player.levels().level : 0})`;
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [track, playing]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const run = (fn: () => void) => () => { setMenuOpen(false); fn(); };
  const seekTo = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!track) return;
    const r = e.currentTarget.getBoundingClientRect();
    studio.seek(((e.clientX - r.left) / r.width) * track.durationSec);
  };

  return (
    <div className="transport" role="region" aria-label="Transport">
      <div className="transport-main">
        <button className="play" onClick={studio.togglePlay} disabled={!ready} aria-keyshortcuts="Space">
          {!ready ? `Loading ${Math.round(loadProgress * 100)}%` : playing ? "■ Stop" : "▶ Play"}
        </button>
        <button onClick={studio.newTake} disabled={!ready} title="Write a new track with these settings (G)">New take</button>
        <button onClick={studio.randomise} disabled={!ready} title="Surprise me (R)">Surprise me</button>
      </div>

      <div className="position">
        <div className="readout">
          <span className="section-name" ref={section}>Intro</span>
          <span className="bar">Bar <span ref={bar}>1.1</span></span>
          {track && <span className="meta">{track.bpm} BPM</span>}
          <span className="status" role="status">{busy ? `${status}…` : status}</span>
        </div>
        <button className="scrub" onClick={seekTo} aria-label="Jump to a position in the track">
          <span className="scrub-fill" ref={fill} />
        </button>
      </div>

      <div className="transport-side">
        <div className="meter" aria-hidden="true"><div ref={meter} /></div>
        <button onClick={studio.cycleLoop} aria-label={LOOP_LABEL[loop]} title={LOOP_LABEL[loop]} className={loop === "off" ? "" : "active"}>
          {LOOP_LABEL[loop]}
        </button>
        <button onClick={studio.share} disabled={!ready}>{copied ? "Copied" : "Share"}</button>
        <div className="menu-wrap" ref={menu}>
          <button aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)} disabled={!ready || busy}>
            {busy ? "Working…" : "Export"}
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={run(studio.exportWav)}>Full mix (WAV)</button>
              <button role="menuitem" onClick={run(studio.exportStems)}>Stems (6 WAVs)</button>
              <button role="menuitem" onClick={run(studio.exportMidi)}>Notes (MIDI)</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
