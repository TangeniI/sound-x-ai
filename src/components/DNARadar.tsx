/**
 * DNARadar.tsx
 *
 * Animated radar / spider chart showing the musical "DNA" of the current track.
 * Axes: Energy · Valence · Danceability · Acousticness · Tempo (normalised)
 *
 * Design:
 *   - Acid-green filled polygon on dark background
 *   - Concentric grid rings (0.25 / 0.5 / 0.75 / 1.0)
 *   - Axis labels with monospaced typography
 *   - Smooth lerp animation when values change
 *   - Subtle rotating outer ring (scanner aesthetic)
 */

import { useEffect, useRef } from "react";

export interface AudioFeatures {
  tempo:        number;
  energy:       number;
  valence:      number;
  danceability: number;
  acousticness: number;
}

interface Props {
  audioFeatures?: AudioFeatures | null;
  size?:          number;
}

const AXES = [
  { key: "energy",       label: "ENERGY"   },
  { key: "valence",      label: "VALENCE"  },
  { key: "danceability", label: "DANCE"    },
  { key: "acousticness", label: "ACOUSTIC" },
  { key: "tempo",        label: "TEMPO"    },
] as const;

const ACID  = "rgba(184,255,44,";
const RINGS = [0.25, 0.5, 0.75, 1.0];

function hexToRadians(i: number, total: number) {
  return (i / total) * Math.PI * 2 - Math.PI / 2;
}

export default function DNARadar({ audioFeatures, size = 240 }: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const rafRef       = useRef<number>(0);
  const currentRef   = useRef<number[]>([0.5, 0.5, 0.5, 0.5, 0.5]);
  const targetRef    = useRef<number[]>([0.5, 0.5, 0.5, 0.5, 0.5]);
  const scanAngleRef = useRef<number>(0);

  // Update target values when audio features change
  useEffect(() => {
    if (!audioFeatures) return;
    targetRef.current = [
      audioFeatures.energy,
      audioFeatures.valence,
      audioFeatures.danceability,
      audioFeatures.acousticness,
      Math.min((audioFeatures.tempo - 60) / 140, 1), // normalise 60–200 BPM → 0–1
    ];
  }, [audioFeatures]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const S   = size;
    canvas.width  = S;
    canvas.height = S;

    const cx  = S / 2;
    const cy  = S / 2;
    const R   = S * 0.36;
    const N   = AXES.length;

    let lastTime = performance.now();

    function draw(now: number) {
      rafRef.current = requestAnimationFrame(draw);
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      scanAngleRef.current += dt * 0.4; // slow scanner rotation

      // Lerp current toward target
      for (let i = 0; i < N; i++) {
        currentRef.current[i] += (targetRef.current[i] - currentRef.current[i]) * Math.min(dt * 3, 1);
      }

      ctx.clearRect(0, 0, S, S);

      // ── background ──────────────────────────────────────────────
      ctx.fillStyle = "rgba(3,7,3,0.85)";
      ctx.beginPath();
      ctx.arc(cx, cy, R + 24, 0, Math.PI * 2);
      ctx.fill();

      // ── concentric rings ─────────────────────────────────────────
      RINGS.forEach((scale) => {
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const angle = hexToRadians(i, N);
          const px    = cx + Math.cos(angle) * R * scale;
          const py    = cy + Math.sin(angle) * R * scale;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = `rgba(184,255,44,${scale === 1 ? 0.14 : 0.06})`;
        ctx.lineWidth   = scale === 1 ? 0.8 : 0.5;
        ctx.stroke();
      });

      // ── axis spokes ───────────────────────────────────────────────
      for (let i = 0; i < N; i++) {
        const angle = hexToRadians(i, N);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R);
        ctx.strokeStyle = "rgba(184,255,44,0.07)";
        ctx.lineWidth   = 0.5;
        ctx.stroke();
      }

      // ── data polygon ──────────────────────────────────────────────
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const angle = hexToRadians(i, N);
        const val   = currentRef.current[i];
        const px    = cx + Math.cos(angle) * R * val;
        const py    = cy + Math.sin(angle) * R * val;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();

      // Fill
      ctx.fillStyle = ACID + "0.08)";
      ctx.fill();

      // Stroke
      ctx.strokeStyle = ACID + "0.80)";
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Data points
      for (let i = 0; i < N; i++) {
        const angle = hexToRadians(i, N);
        const val   = currentRef.current[i];
        const px    = cx + Math.cos(angle) * R * val;
        const py    = cy + Math.sin(angle) * R * val;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = ACID + "1)";
        ctx.fill();
      }

      // ── rotating scanner beam ─────────────────────────────────────
      const scanA = scanAngleRef.current;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(scanA);
      const scanGrad = ctx.createLinearGradient(0, 0, R, 0);
      scanGrad.addColorStop(0,   "rgba(184,255,44,0.00)");
      scanGrad.addColorStop(0.7, "rgba(184,255,44,0.06)");
      scanGrad.addColorStop(1,   "rgba(184,255,44,0.02)");
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R + 8, -0.3, 0.3);
      ctx.closePath();
      ctx.fillStyle = scanGrad;
      ctx.fill();
      ctx.restore();

      // ── outer ring tick marks ─────────────────────────────────────
      for (let i = 0; i < 36; i++) {
        const a   = (i / 36) * Math.PI * 2;
        const len = i % 9 === 0 ? 6 : 3;
        const r1  = R + 14;
        const r2  = r1 + len;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.strokeStyle = `rgba(184,255,44,${i % 9 === 0 ? 0.30 : 0.10})`;
        ctx.lineWidth   = i % 9 === 0 ? 1 : 0.5;
        ctx.stroke();
      }

      // ── axis labels ───────────────────────────────────────────────
      ctx.font      = '7px "SF Mono", "Fira Code", monospace';
      ctx.textAlign = "center";

      AXES.forEach(({ label }, i) => {
        const angle = hexToRadians(i, N);
        const lx    = cx + Math.cos(angle) * (R + 26);
        const ly    = cy + Math.sin(angle) * (R + 26);
        const val   = currentRef.current[i];

        // label
        ctx.fillStyle = "rgba(184,255,44,0.45)";
        ctx.fillText(label, lx, ly - 4);

        // value percentage
        ctx.fillStyle = "rgba(184,255,44,0.70)";
        ctx.fillText(`${Math.round(val * 100)}`, lx, ly + 6);
      });

      // ── centre dot ───────────────────────────────────────────────
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = ACID + "0.6)";
      ctx.fill();
    }

    rafRef.current = requestAnimationFrame(draw);

    return () => cancelAnimationFrame(rafRef.current);
  }, [size]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{
        fontFamily: '"SF Mono", "Fira Code", monospace',
        fontSize:   9,
        letterSpacing: "0.28em",
        color:      "rgba(184,255,44,0.35)",
      }}>
        // DNA.RADAR
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: "block", borderRadius: "50%" }}
      />
    </div>
  );
}