/**
 * NeuralPanel.tsx
 *
 * Shows the GRU thinking. Each column is a 16th note and each row a scale degree.
 * Brightness is how likely the model thought that note was, and the outlined cell
 * is what it actually chose. Click any cell to hold that note: the model then
 * carries on from it, so everything after that step changes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Studio } from "../hooks/useStudio";
import { player } from "../lib/audio/player";
import { neuralRiff } from "../lib/neural-engine";

const H = 188;
const REST_H = 16;

export default function NeuralPanel({ studio }: { studio: Studio }) {
  const { track, config, pinRiff, playing } = studio;
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const riff = track?.riff;
  const inGroove = !!track?.family;

  // rows run high to low; REST sits apart at the bottom, BOS is never shown
  const rows = useMemo(() => {
    if (!riff?.neural) return [];
    const degrees = riff.vocab
      .map((degree, token) => ({ degree, token }))
      .filter((r): r is { degree: number; token: number } => r.degree != null && r.degree >= -5 && r.degree <= 10);
    return degrees.sort((a, b) => b.degree - a.degree);
  }, [riff]);
  const restToken = riff?.vocab.findIndex((v) => v === null) ?? 0;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => setWidth(Math.max(160, el.clientWidth));
    fit(); // an observer stays quiet while the page is hidden
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [inGroove]); // Groove has no heatmap, so it mounts again with the other styles

  useEffect(() => {
    const c = canvas.current;
    if (!c || !riff?.neural || !track) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = width * dpr;
    c.height = (H + REST_H) * dpr;
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const cw = width / riff.probs.length;
    const ch = H / rows.length;
    const barSec = track.stepSec * 16;

    let raf = 0;
    const paint = () => {
      if (playing) raf = requestAnimationFrame(paint);
      ctx.clearRect(0, 0, width, H + REST_H);
      riff.probs.forEach((p, s) => {
        const x = s * cw;
        rows.forEach((r, y) => {
          const v = Math.min(1, p[r.token] * 2.4);
          ctx.fillStyle = `rgba(255,92,53,${0.04 + v * 0.8})`;
          ctx.fillRect(x + 0.5, y * ch + 0.5, cw - 1, ch - 1);
        });
        const rest = p[restToken];
        ctx.fillStyle = `rgba(160,164,168,${0.06 + rest * 0.6})`;
        ctx.fillRect(x + 0.5, H + 2, cw - 1, REST_H - 3);

        const chosen = riff.tokens[s];
        const y = chosen === restToken ? H + 2 : rows.findIndex((r) => r.token === chosen) * ch;
        if (y >= 0) {
          ctx.strokeStyle = config.pins[s] != null ? "#ffd2a0" : "#f2eee7";
          ctx.lineWidth = config.pins[s] != null ? 2 : 1.25;
          ctx.strokeRect(x + 1, y + 1, cw - 2, (chosen === restToken ? REST_H - 3 : ch) - 2);
        }
        if (s > 0 && s % 8 === 0) {
          ctx.fillStyle = s % 16 === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.14)";
          ctx.fillRect(x, 0, 1, H + REST_H);
        }
      });
      if (player.playing) {
        const step = (player.position() / barSec * 16) % riff.probs.length;
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.fillRect(step * cw, 0, 1.5, H + REST_H);
      }
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [riff, rows, restToken, track, width, config.pins, playing, studio.seeks]);

  function click(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!riff?.neural) return;
    const r = e.currentTarget.getBoundingClientRect();
    const step = Math.floor(((e.clientX - r.left) / r.width) * riff.probs.length);
    const y = e.clientY - r.top;
    const token = y >= H ? restToken : rows[Math.min(rows.length - 1, Math.floor((y / H) * rows.length))]?.token;
    if (token != null) pinRiff(step, token);
  }

  if (inGroove) {
    return (
      <p className="model-note">
        Groove is written from hand-built families. The trained sequence model writes the other five styles,{" "}
        <a href="https://github.com/TangeniI/sound-x-ai#the-model" target="_blank" rel="noreferrer">about the model</a>.
      </p>
    );
  }
  const held = Object.keys(config.pins).length;
  const meta = neuralRiff.meta;

  return (
    <section className="panel neural" aria-label="Neural riff model">
      <div className="panel-head">
        <h2>Sequence model</h2>
        <span className={riff?.neural ? "badge on" : "badge"}>{riff?.neural ? "GRU, running locally" : "Markov fallback"}</span>
      </div>
      <p className="lede">
        Bright cells are the notes the network thought likely at each 16th. The outline is what it chose.
        <strong> Click a cell to hold that note</strong>, and it rewrites everything after it. Each style plays some or all of these notes.
      </p>
      <div ref={wrap} className="heat">
        <canvas ref={canvas} role="img" aria-label="Probability of each note at each step of the riff" style={{ width, height: H + REST_H }} onClick={click} />
      </div>
      <div className="heat-foot">
        <span>{held ? `${held} held` : "2 bars"} · temperature {riff?.temperature.toFixed(2)}</span>
        {meta && <span>Trained on {meta.riffs.toLocaleString("en-GB")} riffs from 80s and 90s dance and pop · {meta.testNats.toFixed(2)} nats on unseen artists, n-gram baseline {meta.baselineNats.toFixed(2)}</span>}
      </div>
    </section>
  );
}
