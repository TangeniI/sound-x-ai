/**
 * App.tsx
 *
 * Root component. Lays out the studio and handles keyboard shortcuts. All state
 * lives in useStudio.
 */

import { useEffect, useRef, useState } from "react";
import AudioReactiveBackground from "./components/AudioReactiveBackground";
import CharacterDisplay from "./components/CharacterDisplay";
import Controls from "./components/Controls";
import Credits from "./components/Credits";
import DNARadar from "./components/DNARadar";
import NeuralPanel from "./components/NeuralPanel";
import TrackTimeline from "./components/TrackTimeline";
import Transport from "./components/Transport";
import AudioDropzone from "./components/AudioDropzone";
import { useStudio } from "./hooks/useStudio";
import { player } from "./lib/audio/player";
import { featuresFromConfig } from "./lib/generative-engine";

/** Counts beats off the audio clock and re-renders only the droid. */
function useBeat(stepSec: number, playing: boolean): number {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const b = Math.floor(player.position() / (stepSec * 4));
      if (b !== last) { last = b; setBeat(b); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stepSec, playing]);
  return beat;
}

export default function App() {
  const studio = useStudio();
  const { config, track, playing } = studio;
  const dna = { ...featuresFromConfig(config), source: studio.source?.source ?? "CONTROLS" };
  const beat = useBeat(track?.stepSec ?? 0.1, playing);
  const [creditsOpen, setCreditsOpen] = useState(false);

  const keys = useRef(studio);
  keys.current = studio;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave browser shortcuts alone
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      if (tag === "TEXTAREA" || el?.isContentEditable) return;
      const s = keys.current;
      if (e.code === "Space") {
        // a focused control keeps its own Space behaviour
        if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "LABEL") return;
        e.preventDefault();
        void s.togglePlay();
      } else if (tag !== "INPUT" || (el as HTMLInputElement).type === "range" || (el as HTMLInputElement).type === "radio") {
        if (e.key === "g" || e.key === "G") void s.newTake();
        if (e.key === "r" || e.key === "R") void s.randomise();
        if (e.key === "l" || e.key === "L") s.cycleLoop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <AudioReactiveBackground features={dna} playing={playing} />
      <div className="app">
        <header className="top">
          <div className="brand">
            <h1>Sound <span>×</span> AI</h1>
            <p>Techno built from real drum machines and recordings, written by a neural net trained on real riffs. It all runs in your browser.</p>
          </div>
          <nav>
            <button className="link" onClick={() => setCreditsOpen(true)}>Sounds &amp; credits</button>
            <a className="link" href="https://github.com/TangeniI/sound-x-ai" target="_blank" rel="noreferrer">GitHub ↗</a>
          </nav>
        </header>

        <main className="layout">
          <div className="col-side">
            <Controls studio={studio} />
            <AudioDropzone onFile={studio.analyse} />
          </div>
          <div className="col-main">
            <TrackTimeline studio={studio} />
            <div className="row">
              <NeuralPanel studio={studio} />
              <section className="panel vitals" aria-label="Track DNA">
                <div className="panel-head"><h2>Track DNA</h2></div>
                <DNARadar audioFeatures={dna} size={224} />
                <CharacterDisplay beatCount={beat} isPlaying={playing} audioFeatures={dna} />
              </section>
            </div>
            <p className="shortcuts">
              <kbd>Space</kbd> play <kbd>G</kbd> new take <kbd>R</kbd> surprise me <kbd>L</kbd> loop
            </p>
          </div>
        </main>
      </div>
      <Transport studio={studio} />
      {creditsOpen && <Credits onClose={() => setCreditsOpen(false)} />}
    </>
  );
}
