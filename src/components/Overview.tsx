/**
 * Overview.tsx
 *
 * The whole track on one screen. Each row is a part and each cell a bar, filled
 * by how much that part plays, so you can see layers enter, thin out and leave.
 * Click anywhere to play from there.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Studio } from "../hooks/useStudio";
import { player } from "../lib/audio/player";
import { clock, keyName, LANE_COLOR, LANE_LABEL, SECTION_LABEL } from "../lib/labels";
import { LANES } from "../types";

const ROW = 24;
const H = LANES.length * ROW;

export default function Overview({ studio }: { studio: Studio }) {
  const { track, playing } = studio;
  const canvas = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(160, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bars = track ? track.sections.reduce((n, s) => n + s.bars, 0) : 1;

  // notes per bar, each part scaled to its own busiest bar
  const activity = useMemo(() => LANES.map((lane) => {
    const count = new Array<number>(bars).fill(0);
    for (const n of track?.notes ?? []) {
      if (n.instrument !== lane) continue;
      const first = Math.floor(n.step / 16);
      // a held chord fills every bar it sounds in
      const span = lane === "pad" ? Math.ceil((n.endTime - n.startTime) / (track!.stepSec * 16) - 0.01) : 1;
      for (let b = first; b < Math.min(bars, first + span); b++) count[b] += n.velocity;
    }
    const max = Math.max(1, ...count);
    return count.map((v) => v / max);
  }), [track, bars]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !track) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = width * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const w = width / bars;
    activity.forEach((row, i) => {
      g.fillStyle = LANE_COLOR[LANES[i]];
      row.forEach((v, bar) => {
        if (!v) return;
        g.globalAlpha = 0.2 + v * 0.7;
        g.fillRect(bar * w, i * ROW + 4, Math.max(1, w - (w > 5 ? 1 : 0)), ROW - 8);
      });
    });
    g.globalAlpha = 1;
    g.fillStyle = "rgba(255,255,255,0.16)";
    for (const s of track.sections.slice(1)) g.fillRect(Math.round(s.startBar * w), 0, 1, H);
  }, [track, activity, width, bars]);

  useEffect(() => {
    if (!track) return;
    let raf = 0;
    const paint = () => {
      if (head.current) head.current.style.transform = `translateX(${(player.position() / track.durationSec) * width}px)`;
      if (playing) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [track, playing, width, studio.seeks]);

  const barSec = track ? track.stepSec * 16 : 0;

  return (
    <section className="panel overview" aria-label="Arrangement">
      <div className="panel-head">
        <h2>Arrangement</h2>
        {track?.family && <p className="family"><strong>{track.family.name}</strong> {track.family.about}</p>}
        {track && (
          <dl className="facts">
            <div><dt>Key</dt><dd>{keyName(track)}</dd></div>
            <div><dt>Tempo</dt><dd>{track.bpm}</dd></div>
            <div><dt>Length</dt><dd>{clock(track.durationSec)}</dd></div>
          </dl>
        )}
      </div>
      <div className="overview-grid">
        <div className="sections" role="group" aria-label="Sections of the track">
          {track?.sections.map((s) => (
            <button
              key={s.startBar}
              className={`section ${s.kind}`}
              style={{ flexGrow: s.bars }}
              onClick={() => studio.seek(s.startBar * barSec)}
              aria-label={`Jump to ${SECTION_LABEL[s.kind]}, bar ${s.startBar + 1}`}
              title={`${SECTION_LABEL[s.kind]}, ${s.bars} bars`}
            >
              {SECTION_LABEL[s.kind]}
            </button>
          ))}
        </div>
        <div className="overview-names" aria-hidden="true">
          {LANES.map((l) => <span key={l} style={{ height: ROW }}>{LANE_LABEL[l]}</span>)}
        </div>
        <div className="overview-canvas" ref={wrap}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={`Which parts play in each of the ${bars} bars`}
            style={{ width, height: H }}
            onClick={(e) => {
              if (!track) return;
              const r = e.currentTarget.getBoundingClientRect();
              const bar = Math.floor(((e.clientX - r.left) / r.width) * bars);
              studio.seek(bar * barSec);
            }}
          />
          <div className="playhead" ref={head} />
        </div>
      </div>
    </section>
  );
}
