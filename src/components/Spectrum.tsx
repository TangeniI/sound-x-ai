/**
 * Spectrum.tsx
 *
 * The master output on a log frequency axis. It shows only what is measured, and
 * only runs while the track plays.
 */

import { useEffect, useRef, useState } from "react";
import { player } from "../lib/audio/player";

const H = 150;
const LO = 30;
const HI = 18000;
const MARKS: [number, string][] = [[60, "60"], [250, "250"], [1000, "1k"], [4000, "4k"], [10000, "10k"]];

export default function Spectrum({ playing }: { playing: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(300);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(160, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = width * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.font = '10px "JetBrains Mono", monospace';
    let raf = 0;
    const paint = () => {
      g.clearRect(0, 0, width, H);
      for (const [hz, label] of MARKS) {
        const x = (Math.log(hz / LO) / Math.log(HI / LO)) * width;
        g.fillStyle = "rgba(255,255,255,0.07)";
        g.fillRect(x, 0, 1, H - 16);
        g.fillStyle = "#99958e";
        g.fillText(label, x - 6, H - 3);
      }
      const spectrum = playing ? player.spectrum() : null;
      if (spectrum) {
        const { db, hz, floor, top } = spectrum;
        g.beginPath();
        g.moveTo(0, H - 16);
        for (let x = 0; x <= width; x += 2) {
          const bin = Math.min(db.length - 2, (LO * (HI / LO) ** (x / width)) / hz);
          const i = Math.floor(bin);
          const v = db[i] + (db[i + 1] - db[i]) * (bin - i);
          const y = Math.max(0, Math.min(1, (v - floor) / (top - floor)));
          g.lineTo(x, (1 - y) * (H - 16));
        }
        g.strokeStyle = "#ff5c35";
        g.stroke();
        g.lineTo(width, H - 16);
        g.closePath();
        g.fillStyle = "rgba(255,92,53,0.12)";
        g.fill();
        raf = requestAnimationFrame(paint);
      }
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [playing, width]);

  return (
    <section className="panel spectrum" aria-label="Master output">
      <div className="panel-head"><h2>Master output</h2><span className="hint">Hz</span></div>
      <div className="screen" ref={wrap}>
        <canvas ref={canvas} role="img" aria-label="Live frequency spectrum of the master" style={{ width, height: H }} />
      </div>
    </section>
  );
}
