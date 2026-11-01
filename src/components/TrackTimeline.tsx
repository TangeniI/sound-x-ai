/**
 * TrackTimeline.tsx
 *
 * The arrangement and piano roll. The section strip shows the whole track; the
 * roll below shows eight bars and follows the playhead. Notes are drawn once to
 * an offscreen layer, and only the playhead moves each frame.
 *
 * Pitches map to height the same way in both directions, so a note you add lands
 * exactly where you clicked. Each lane has its own mixer strip.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Studio } from "../hooks/useStudio";
import type { ChannelId } from "../lib/audio/graph";
import { player } from "../lib/audio/player";
import type { Lane, NoteEvent, Section, Track } from "../types";

const VIEW_BARS = 8;
const STEPS = VIEW_BARS * 16;

interface LaneDef {
  id: Lane;
  label: string;
  color: string;
  height: number;
  rows?: { pitch: number; pitches: number[]; label: string }[]; // fixed rows for drums
  range?: [number, number];
}

const LANE_DEFS: LaneDef[] = [
  { id: "lead", label: "Lead", color: "#b8ff2c", height: 76, range: [60, 84] },
  { id: "pad", label: "Pad", color: "#a593ff", height: 34, range: [48, 74] },
  { id: "stab", label: "Stab", color: "#2cdcff", height: 40, range: [48, 62] },
  { id: "bass", label: "Bass", color: "#ff6aa9", height: 62, range: [26, 50] },
  { id: "perc", label: "Perc", color: "#ffd24a", height: 54, rows: [
    { pitch: 56, pitches: [56], label: "1" },
    { pitch: 60, pitches: [60], label: "2" },
    { pitch: 64, pitches: [64], label: "3" },
  ] },
  { id: "drums", label: "Drums", color: "#ffb02c", height: 88, rows: [
    { pitch: 51, pitches: [49, 51], label: "ride" },
    { pitch: 42, pitches: [42, 46], label: "hats" },
    { pitch: 39, pitches: [37, 39], label: "clap" },
    { pitch: 36, pitches: [36], label: "kick" },
  ] },
];

const TOTAL_H = LANE_DEFS.reduce((n, l) => n + l.height, 0);

const SECTION_LABEL: Record<string, string> = {
  intro: "Intro", groove: "Groove", riff: "Riff", break: "Break", build: "Build", drop: "Drop", outro: "Outro",
};

/** Each lane scales to the notes it actually has, so a riff shows its shape. */
function laneRange(def: LaneDef, track: Track): [number, number] {
  const pitches = track.notes.filter((n) => n.instrument === def.id).map((n) => n.pitch);
  if (!pitches.length) return def.range ?? [0, 127];
  const lo = Math.min(...pitches), hi = Math.max(...pitches);
  return [lo - 1, Math.max(hi + 1, lo + 7)];
}

function laneTop(index: number): number {
  let y = 0;
  for (let i = 0; i < index; i++) y += LANE_DEFS[i].height;
  return y;
}

function rowFor(def: LaneDef, n: NoteEvent, range: [number, number]): { y: number; h: number } {
  if (def.rows) {
    const h = def.height / def.rows.length;
    const i = def.rows.findIndex((r) => r.pitches.includes(n.pitch));
    return { y: Math.max(0, i) * h + 2, h: h - 4 };
  }
  const span = range[1] - range[0];
  const h = Math.max(3, def.height / (span + 1));
  return { y: (1 - (n.pitch - range[0]) / span) * (def.height - h), h };
}

function drawNotes(ctx: CanvasRenderingContext2D, track: Track, firstBar: number, W: number) {
  ctx.clearRect(0, 0, W, TOTAL_H);
  const stepW = W / STEPS;
  const firstStep = firstBar * 16;

  LANE_DEFS.forEach((def, i) => {
    const top = laneTop(i);
    ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.018)" : "rgba(255,255,255,0.0)";
    ctx.fillRect(0, top, W, def.height);
    ctx.fillStyle = "rgba(184,255,44,0.16)";
    ctx.fillRect(0, top + def.height - 1, W, 1);
  });

  for (let s = 0; s <= STEPS; s += 4) {
    const bar = s % 16 === 0;
    ctx.fillStyle = bar ? "rgba(184,255,44,0.26)" : "rgba(184,255,44,0.07)";
    ctx.fillRect(Math.round(s * stepW), 0, 1, TOTAL_H);
    if (bar && s < STEPS) {
      ctx.fillStyle = "#a7b8a2";
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillText(String(firstBar + s / 16 + 1), s * stepW + 5, 13);
    }
  }

  LANE_DEFS.forEach((def, i) => {
    const top = laneTop(i);
    const range = laneRange(def, track);
    ctx.fillStyle = def.color;
    for (const n of track.notes) {
      if (n.instrument !== def.id || n.step < firstStep || n.step >= firstStep + STEPS) continue;
      const x = (n.step - firstStep) * stepW;
      const w = Math.max(2.5, ((n.endTime - n.startTime) / track.stepSec) * stepW - 1);
      const { y, h } = rowFor(def, n, range);
      ctx.globalAlpha = 0.35 + (n.velocity / 127) * 0.65;
      ctx.fillRect(x, top + y, Math.min(w, W - x), h);
    }
  });
  ctx.globalAlpha = 1;
}

function SectionStrip({ track, seek, firstBar, jump }: { track: Track; seek: (s: number) => void; firstBar: number; jump: (bar: number) => void }) {
  const total = track.sections.reduce((n, s) => n + s.bars, 0);
  const barSec = track.stepSec * 16;
  const open = (s: Section) => {
    jump(s.startBar);
    seek(s.startBar * barSec);
  };
  return (
    <div className="sections" role="group" aria-label="Sections of the track">
      {track.sections.map((s) => {
        const inView = s.startBar < firstBar + VIEW_BARS && s.startBar + s.bars > firstBar;
        return (
          <button key={s.startBar} className={`section ${s.kind}${inView ? " in-view" : ""}`} style={{ flexGrow: s.bars / total }} onClick={() => open(s)} aria-label={`Jump to ${SECTION_LABEL[s.kind]}, bar ${s.startBar + 1}`}>
            {SECTION_LABEL[s.kind]}
          </button>
        );
      })}
    </div>
  );
}

function Strip({ id, label, color, studio, reroll }: { id: ChannelId; label: string; color: string; studio: Studio; reroll?: () => void }) {
  const on = !studio.muted.has(id);
  return (
    <div className="strip-inner">
      <span className="strip-name" style={{ color }}>{label}</span>
      <button className={on ? "chip" : "chip mute"} aria-pressed={!on} aria-label={`Mute ${label}`} title={`Mute ${label}`} onClick={() => studio.toggleMute(id)}>M</button>
      <button className={studio.soloed.has(id) ? "chip solo" : "chip"} aria-pressed={studio.soloed.has(id)} aria-label={`Solo ${label}`} title={`Solo ${label}`} onClick={() => studio.toggleSolo(id)}>S</button>
      {reroll && <button className="chip" aria-label={`Rewrite ${label}`} title={`Write a new ${label.toLowerCase()} part`} onClick={reroll}>↻</button>}
    </div>
  );
}

export default function TrackTimeline({ studio }: { studio: Studio }) {
  const { track, playing, toggleNote } = studio;
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(800);
  const [firstBar, setFirstBar] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const totalBars = track ? track.sections.reduce((n, s) => n + s.bars, 0) : 0;
  const lastPage = Math.max(0, totalBars - VIEW_BARS);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (firstBar > lastPage) setFirstBar(0);
  }, [firstBar, lastPage]);

  // redraw the notes only when something about them changes
  useEffect(() => {
    if (!track) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const off = layer.current ?? document.createElement("canvas");
    layer.current = off;
    off.width = width * dpr;
    off.height = TOTAL_H * dpr;
    const ctx = off.getContext("2d")!;
    ctx.scale(dpr, dpr);
    drawNotes(ctx, track, firstBar, width);
    const c = canvas.current;
    if (c) {
      c.width = width * dpr;
      c.height = TOTAL_H * dpr;
    }
  }, [track, firstBar, width]);

  useEffect(() => {
    let raf = 0;
    const c = canvas.current;
    if (!c || !track) return;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const barSec = track.stepSec * 16;
    const stepW = width / STEPS;

    const paint = () => {
      raf = requestAnimationFrame(paint);
      const off = layer.current;
      if (!off || off.width === 0) return;
      const pos = player.position();
      const bar = pos / barSec;
      if (playing) {
        // turn the page as the playhead reaches the end of the view
        const page = Math.min(lastPage, Math.floor(bar / VIEW_BARS) * VIEW_BARS);
        if (page !== firstBar) setFirstBar(page);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(off, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (hover) {
        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.fillRect(Math.floor(hover.x / stepW) * stepW, hover.y - 3, stepW, 6);
      }
      const x = (bar - firstBar) * (width / VIEW_BARS);
      if (x >= 0 && x <= width) {
        ctx.fillStyle = "#f4ffe6";
        ctx.fillRect(x, 0, 1.5, TOTAL_H);
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [track, playing, firstBar, width, hover, lastPage]);

  const summary = useMemo(() => {
    if (!track) return "Piano roll";
    return `Piano roll showing bars ${firstBar + 1} to ${firstBar + VIEW_BARS} of ${totalBars}. ${track.notes.length} notes in the track.`;
  }, [track, firstBar, totalBars]);

  function hitTest(e: React.MouseEvent<HTMLCanvasElement>): void {
    if (!track) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const stepW = r.width / STEPS;
    const step = firstBar * 16 + Math.floor(x / stepW);
    let top = 0;
    for (const def of LANE_DEFS) {
      if (y < top + def.height) {
        const local = y - top;
        if (def.rows) {
          const row = def.rows[Math.min(def.rows.length - 1, Math.floor(local / (def.height / def.rows.length)))];
          const hit = track.notes.find((n) => n.instrument === def.id && n.step === step && row.pitches.includes(n.pitch));
          toggleNote(def.id, step, hit ? hit.pitch : row.pitch);
          return;
        }
        const range = laneRange(def, track);
        const span = range[1] - range[0];
        const h = Math.max(3, def.height / (span + 1));
        const exact = range[0] + (1 - clamp01(local / (def.height - h))) * span;
        const near = track.notes
          .filter((n) => n.instrument === def.id && n.step === step)
          .sort((a, b) => Math.abs(a.pitch - exact) - Math.abs(b.pitch - exact))[0];
        if (near && Math.abs(near.pitch - exact) <= 1.5) {
          toggleNote(def.id, step, near.pitch);
        } else {
          toggleNote(def.id, step, snapToScale(Math.round(exact), track));
        }
        return;
      }
      top += def.height;
    }
  }

  return (
    <section className="panel timeline" aria-label="Arrangement">
      <div className="panel-head">
        <h2>Arrangement</h2>
        <div className="pager">
          <span className="hint">Click the grid to add or remove notes</span>
          <button aria-label="Previous bars" disabled={firstBar === 0} onClick={() => setFirstBar(Math.max(0, firstBar - VIEW_BARS))}>‹</button>
          <span aria-live="polite">Bars {firstBar + 1} to {firstBar + VIEW_BARS}</span>
          <button aria-label="Next bars" disabled={firstBar >= lastPage} onClick={() => setFirstBar(Math.min(lastPage, firstBar + VIEW_BARS))}>›</button>
        </div>
      </div>

      {track && <SectionStrip track={track} seek={studio.seek} firstBar={firstBar} jump={(b) => setFirstBar(Math.min(lastPage, Math.floor(b / VIEW_BARS) * VIEW_BARS))} />}

      <div className="roll">
        <div className="strips">
          {LANE_DEFS.map((l) => (
            <div key={l.id} className="strip" style={{ height: l.height }}>
              <Strip id={l.id} label={l.label} color={l.color} studio={studio} reroll={() => studio.rerollLane(l.id)} />
            </div>
          ))}
        </div>
        <div className="roll-canvas" ref={wrap}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={summary}
            data-notes={track?.notes.length ?? 0}
            style={{ width, height: TOTAL_H }}
            onClick={hitTest}
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onMouseLeave={() => setHover(null)}
          />
        </div>
      </div>

      <div className="rumble-strip">
        <Strip id="rumble" label="Rumble" color="#ff8f5a" studio={studio} />
        <span className="hint">Sub layer: a long TR-808 kick through a stone hall and distortion, ducked on every hit</span>
      </div>
    </section>
  );
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** New notes land on the scale. */
function snapToScale(pitch: number, track: Track): number {
  for (let off = 0; off < 7; off++) {
    for (const p of [pitch + off, pitch - off]) {
      if (track.scale.includes(((p - track.root) % 12 + 12) % 12)) return p;
    }
  }
  return pitch;
}
