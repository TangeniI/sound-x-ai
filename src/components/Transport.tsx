/**
 * Transport.tsx
 *
 * The bar that stays on screen: play, new take, position, loop, level, MIDI out, export.
 * Position and meters are drawn from the audio clock in their own loop, so the
 * rest of the app doesn't re-render as the track plays. On a phone, everything
 * but Play and Export folds into a "More" menu.
 */

import { useEffect, useRef, useState } from "react";
import { useMidi } from "../hooks/useMidi";
import { LOOP_BARS, type LoopMode, type Studio } from "../hooks/useStudio";
import { player } from "../lib/audio/player";
import { familyOf } from "../lib/groove/parts";
import { clock, NOTE_NAMES, SECTION_LABEL, STYLES } from "../lib/labels";
import { MidiPanel } from "./MidiPanel";

const LOOP_LABEL: Record<LoopMode, string> = {
  four: "Loop 4 bars", eight: "Loop 8 bars", sixteen: "Loop 16 bars", track: "Loop track", section: "Loop section", off: "Loop off",
};

export default function Transport({ studio }: { studio: Studio }) {
  const { track, ready, loadProgress, playing, status, busy, loop, copied } = studio;
  const [menuOpen, setMenuOpen] = useState<"export" | "more" | "takes" | "midi" | null>(null);
  const midi = useMidi();
  const fileType = studio.format.type === "aiff" ? "AIFF" : "WAV";
  const bar = useRef<HTMLSpanElement>(null);
  const section = useRef<HTMLSpanElement>(null);
  const scrub = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const meter = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const paint = () => {
      if (playing) raf = requestAnimationFrame(paint);
      if (!track) return;
      const pos = Math.min(player.position(), track.durationSec);
      const barSec = track.stepSec * 16;
      const b = Math.floor(pos / barSec);
      const beat = Math.floor((pos / barSec - b) * 4);
      if (bar.current) bar.current.textContent = `${b + 1}.${beat + 1}`;
      const s = track.sections.find((x) => b >= x.startBar && b < x.startBar + x.bars);
      if (section.current && s) section.current.textContent = SECTION_LABEL[s.kind];
      if (time.current) time.current.textContent = clock(pos);
      if (scrub.current) {
        scrub.current.value = String(pos);
        scrub.current.style.setProperty("--done", `${(pos / track.durationSec) * 100}%`);
      }
      if (meter.current) meter.current.style.transform = `scaleX(${playing ? player.level() : 0})`;
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [track, playing, studio.seeks]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".menu-wrap")) setMenuOpen(null);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menuOpen]);

  const run = (fn: () => void) => () => { setMenuOpen(null); fn(); };
  const toggle = (name: "export" | "more" | "takes" | "midi") => () => setMenuOpen((o) => (o === name ? null : name));
  const takeList = studio.takes.map((take) => {
    const { seed, style, rootPitch, tempo } = take.config;
    const current = seed === studio.config.seed;
    return (
      <button key={seed} role="menuitem" aria-current={current || undefined} className={current ? "active" : ""} onClick={run(() => studio.openTake(take))}>
        <span>{style === "driving" ? familyOf(take.config).name : STYLES.find((s) => s.id === style)?.label} {NOTE_NAMES[rootPitch]} {tempo}</span>
        <small>#{seed}{take.edits.length ? `, ${take.edits.length} edit${take.edits.length > 1 ? "s" : ""}` : ""}</small>
      </button>
    );
  });
  return (
    <div className="transport" role="region" aria-label="Transport">
      <div className="transport-main">
        <button className="play" onClick={studio.togglePlay} disabled={!ready} aria-keyshortcuts="Space">
          {!ready ? `Loading ${Math.round(loadProgress * 100)}%` : playing ? "Stop" : "Play"}
        </button>
        <button className="wide-only" onClick={studio.newTake} disabled={!ready} title="Write a new track with these settings (G)">New take</button>
        <button className="wide-only" onClick={studio.randomise} disabled={!ready} title="Randomise (R)">Randomise</button>
        <button className="wide-only step" onClick={studio.undo} disabled={!ready || !studio.canUndo} title="Undo (⌘ or Ctrl Z)">Undo</button>
        <button className="wide-only step" onClick={studio.redo} disabled={!ready || !studio.canRedo} title="Redo (Shift ⌘ or Ctrl Z)">Redo</button>
        <div className="menu-wrap takes-wrap wide-only">
          <button aria-haspopup="menu" aria-expanded={menuOpen === "takes"} onClick={toggle("takes")} disabled={!ready}>Takes</button>
          {menuOpen === "takes" && <div className="menu takes" role="menu">{takeList}</div>}
        </div>
      </div>

      <div className="position">
        <div className="readout">
          <span className="section-name" ref={section}>Intro</span>
          <span className="bar">Bar <span ref={bar}>1.1</span></span>
          {track && <span className="meta"><span ref={time}>0:00</span> / {clock(track.durationSec)}</span>}
          <span className="status" role="status">{busy ? `${status}…` : status}</span>
        </div>
        <input
          ref={scrub} className="scrub" type="range" min={0} max={track?.durationSec ?? 1} step={0.01} defaultValue={0}
          disabled={!ready} onChange={(e) => studio.seek(Number(e.target.value))} aria-label="Position in the track"
        />
      </div>

      <div className="transport-side">
        <div className="meter" aria-hidden="true"><div ref={meter} /></div>
        {LOOP_BARS[loop] && (
          <button className="wide-only" onClick={studio.playFull} disabled={!ready} title="Play the whole arrangement from the top">Full track</button>
        )}
        <button onClick={studio.cycleLoop} aria-label={LOOP_LABEL[loop]} title={LOOP_LABEL[loop]} className={loop === "off" ? "wide-only" : "wide-only active"}>
          {LOOP_LABEL[loop]}
        </button>
        <button className="wide-only" onClick={studio.share} disabled={!ready}>{copied ? "Copied" : "Share"}</button>
        <div className="menu-wrap midi-wrap wide-only">
          <button aria-haspopup="menu" aria-expanded={menuOpen === "midi"} onClick={toggle("midi")} className={midi.port ? "active" : ""}>
            {midi.port ? "MIDI on" : "MIDI"}
          </button>
          {menuOpen === "midi" && (
            <div className="menu export midi" role="menu">
              <span className="menu-head">MIDI out</span>
              <MidiPanel midi={midi} />
            </div>
          )}
        </div>
        <div className="menu-wrap export-wrap">
          <button aria-haspopup="menu" aria-expanded={menuOpen === "export"} onClick={toggle("export")} disabled={!ready || busy}>
            {busy ? "Working…" : "Export"}
          </button>
          {menuOpen === "export" && (
            <div className="menu export" role="menu">
              <span className="menu-head">{studio.hasLoop ? `This loop${LOOP_BARS[loop] ? `, ${LOOP_BARS[loop]} bars` : ""}` : "Loop: turn on a bar or section loop"}</span>
              <button role="menuitem" disabled={!studio.hasLoop} onClick={run(studio.exportLoopWav)}>Loop ({fileType})</button>
              <button role="menuitem" disabled={!studio.hasLoop} onClick={run(() => studio.exportStems(true))}>Loop stems (zip)</button>
              <button role="menuitem" disabled={!studio.hasLoop} onClick={run(() => studio.exportMidi(true))}>Loop notes (MIDI)</button>
              <span className="menu-head">Whole track</span>
              <button role="menuitem" onClick={run(studio.exportWav)}>Full mix ({fileType})</button>
              <button role="menuitem" onClick={run(() => studio.exportStems(false))}>Stems (zip)</button>
              <button role="menuitem" onClick={run(() => studio.exportMidi(false))}>Notes (MIDI)</button>
              {track?.family && <button role="menuitem" onClick={run(studio.exportDjTools)} title="Drum loop, tops loop and the build, to layer in a set">DJ tools (zip)</button>}
              <div className="format" role="group" aria-label="File format">
                {([24, 16] as const).map((bits) => (
                  <button key={bits} aria-pressed={studio.format.bits === bits} onClick={() => studio.setFormat({ ...studio.format, bits })}>{bits}-bit</button>
                ))}
                {([48000, 44100] as const).map((rate) => (
                  <button key={rate} aria-pressed={studio.format.rate === rate} onClick={() => studio.setFormat({ ...studio.format, rate })}>{rate / 1000} kHz</button>
                ))}
                {(["wav", "aiff"] as const).map((type) => (
                  <button key={type} aria-pressed={studio.format.type === type} onClick={() => studio.setFormat({ ...studio.format, type })}
                    title={type === "aiff" ? "DJ software reads AIFF tags most reliably" : undefined}>{type.toUpperCase()}</button>
                ))}
              </div>
              <p className="licence">
                Files carry the tempo, key and Camelot number for DJ software. Stems are WAV: kick, clap and snare, hats, percussion, low end, music and effects, all the same length.
                The recordings are CC0 and the two reverb rooms CC BY 4.0 (see Sounds &amp; credits).
                Sound × AI claims no rights in what you export. Many stores now refuse tracks made wholly
                by generators, so make it your own before you release it. This isn't legal advice.
              </p>
            </div>
          )}
        </div>
        <div className="menu-wrap more-wrap narrow-only">
          <button aria-haspopup="menu" aria-expanded={menuOpen === "more"} onClick={toggle("more")} disabled={!ready}>
            {copied ? "Copied" : "More"}
          </button>
          {menuOpen === "more" && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={run(studio.newTake)}>New take</button>
              <button role="menuitem" onClick={run(studio.randomise)}>Randomise</button>
              <button role="menuitem" onClick={studio.undo} disabled={!studio.canUndo}>Undo</button>
              <button role="menuitem" onClick={studio.redo} disabled={!studio.canRedo}>Redo</button>
              <button role="menuitem" onClick={() => setMenuOpen("takes")}>Earlier takes</button>
              {LOOP_BARS[loop] && <button role="menuitem" onClick={run(studio.playFull)}>Play full track</button>}
              <button role="menuitem" onClick={studio.cycleLoop} className={loop === "off" ? "" : "active"}>{LOOP_LABEL[loop]}</button>
              <button role="menuitem" onClick={run(studio.share)}>Copy share link</button>
            </div>
          )}
          {menuOpen === "takes" && <div className="menu takes" role="menu">{takeList}</div>}
        </div>
      </div>
    </div>
  );
}
