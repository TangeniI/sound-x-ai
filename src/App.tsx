/**
 * App.tsx
 *
 * Root component. Lays out the studio and handles keyboard shortcuts. All state
 * lives in useStudio.
 */

import { useEffect, useRef, useState } from "react";
import AudioDropzone from "./components/AudioDropzone";
import Controls, { StylePicker } from "./components/Controls";
import Credits from "./components/Credits";
import NeuralPanel from "./components/NeuralPanel";
import Overview from "./components/Overview";
import Spectrum from "./components/Spectrum";
import TrackTimeline from "./components/TrackTimeline";
import Transport from "./components/Transport";
import { useStudio } from "./hooks/useStudio";

export default function App() {
  const studio = useStudio();
  const [creditsOpen, setCreditsOpen] = useState(false);

  const keys = useRef(studio);
  keys.current = studio;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLInputElement;
        if (t?.isContentEditable || t?.tagName === "TEXTAREA") return;
        if (t?.tagName === "INPUT" && t.type !== "range" && t.type !== "radio") return;
        e.preventDefault();
        if (e.shiftKey) keys.current.redo(); else keys.current.undo();
        return;
      }
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
      <div className="app">
        <header className="top">
          <div className="brand">
            <h1>Sound <span>×</span> AI</h1>
            <p>Free techno grooves for your DAW. Press play, then take the loop, stems or MIDI into Ableton. No signup.</p>
          </div>
          <nav>
            <button className="link" onClick={() => setCreditsOpen(true)}>Sounds &amp; credits</button>
            <a className="link" href="https://github.com/TangeniI/sound-x-ai" target="_blank" rel="noreferrer">GitHub</a>
          </nav>
        </header>

        <StylePicker studio={studio} />

        <main className="layout">
          <div className="col-main">
            <Overview studio={studio} />
            <TrackTimeline studio={studio} />
            <div className="row">
              <NeuralPanel studio={studio} />
              <Spectrum playing={studio.playing} />
            </div>
            <p className="shortcuts">
              <kbd>Space</kbd> play <kbd>G</kbd> new take <kbd>R</kbd> randomise <kbd>L</kbd> loop <kbd>⌘ / Ctrl Z</kbd> undo
            </p>
          </div>
          <div className="col-side">
            <Controls studio={studio} />
            <AudioDropzone onFile={studio.analyse} />
          </div>
        </main>
      </div>
      <Transport studio={studio} />
      {creditsOpen && <Credits onClose={() => setCreditsOpen(false)} />}
    </>
  );
}
