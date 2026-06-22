/**
 * AudioReactiveBackground.tsx
 *
 * Portfolio aesthetic preserved — sparse matrix rain + drifting nodes + fog orbs.
 * Extended for Sound×AI:
 *   - beat flash: white pulse on canvas when a beat fires
 *   - energy modulates node connection distance & column count visibility
 *   - valence shifts orb hue (green → cyan for high valence)
 *   - tempo scales rain speed
 *
 * Props:
 *   audioFeatures  — current track DNA / analysed features (nullable)
 *   isPlaying      — whether track is currently playing
 *   onBeat         — callback fired on each beat (for CharacterDisplay)
 *   beats          — beat timestamps from audio analysis (seconds)
 *   progressMs     — current playback position in ms
 */

import { useEffect, useRef } from "react";

export interface AudioFeatures {
  tempo:        number;
  energy:       number;
  valence:      number;
  danceability: number;
  acousticness: number;
  beats?:       { start: number; duration: number }[];
}

interface Props {
  audioFeatures?: AudioFeatures | null;
  isPlaying?:     boolean;
  onBeat?:        () => void;
  progressMs?:    number;
}

const CHARS = "01アイウエオカキク{}[]<>/\\;:_.@#|~=+-×÷∑∇λΩ∞█▓░▒".split("");

interface CodeColumn {
  x:            number;
  y:            number;
  speed:        number;
  trail:        string[];
  trailLength:  number;
  opacity:      number;
  charTimer:    number;
  charInterval: number;
}

interface Node {
  x:           number;
  y:           number;
  vx:          number;
  vy:          number;
  r:           number;
  alpha:       number;
  pulseOffset: number;
}

export default function AudioReactiveBackground({
  audioFeatures,
  isPlaying,
  onBeat,
  progressMs = 0,
}: Props) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const rafRef       = useRef<number>(0);
  const onBeatRef    = useRef(onBeat);
  const featuresRef  = useRef(audioFeatures);
  const progressRef  = useRef(progressMs);
  const isPlayingRef = useRef(isPlaying);
  const lastBeatRef  = useRef<number>(-1);
  const beatFlashRef = useRef<number>(0); // 0‥1 flash intensity
  const subFlashRef  = useRef<number>(0); // bass-weighted floor pulse

  // Keep refs in sync with props without re-running the canvas effect
  useEffect(() => { onBeatRef.current    = onBeat;       }, [onBeat]);
  useEffect(() => { featuresRef.current  = audioFeatures; }, [audioFeatures]);
  useEffect(() => { progressRef.current  = progressMs;   }, [progressMs]);
  useEffect(() => { isPlayingRef.current = isPlaying;    }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    // respect prefers-reduced-motion: skip the animated canvas, keep the
    // CSS gradient backdrop. (Still calls onBeat so the character can react.)
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let W = 0, H = 0;
    let t = 0;
    let columns: CodeColumn[] = [];
    let nodes:   Node[]       = [];

    const CELL = 16;

    const baseOrbs = [
      { cx: 0.12, cy: 0.28, r: 0.55, hue: 128, sat: 70, phase: 0.0 },
      { cx: 0.90, cy: 0.55, r: 0.40, hue: 190, sat: 60, phase: 2.3 },
      { cx: 0.50, cy: 0.88, r: 0.35, hue: 112, sat: 65, phase: 4.1 },
    ];

    const resize = () => {
      W = canvas.width  = window.innerWidth;
      H = canvas.height = window.innerHeight;
      initColumns();
      initNodes();
    };

    const randChar = () => CHARS[Math.floor(Math.random() * CHARS.length)];

    function initColumns() {
      const count = 9;
      columns = Array.from({ length: count }, (_, i) => {
        const xFrac = (i + 0.5 + (Math.random() - 0.5) * 0.4) / count;
        const len   = 8 + Math.floor(Math.random() * 10);
        return {
          x:            xFrac * W,
          y:            -Math.random() * H,
          speed:        0.4 + Math.random() * 0.7,
          trail:        Array.from({ length: len }, () => randChar()),
          trailLength:  len,
          opacity:      0.25 + Math.random() * 0.35,
          charTimer:    0,
          charInterval: 6 + Math.floor(Math.random() * 10),
        };
      });
    }

    function initNodes() {
      nodes = Array.from({ length: 45 }, () => ({
        x:           Math.random() * W,
        y:           Math.random() * H,
        vx:          (Math.random() - 0.5) * 0.22,
        vy:          (Math.random() - 0.5) * 0.22,
        r:           1.2 + Math.random() * 1.8,
        alpha:       0.18 + Math.random() * 0.28,
        pulseOffset: Math.random() * Math.PI * 2,
      }));
    }

    window.addEventListener("resize", resize);

    let lastTime = performance.now();

    function draw(now: number) {
      rafRef.current = requestAnimationFrame(draw);
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      t += dt;

      // ── Read audio state ──────────────────────────────────────
      const af         = featuresRef.current;
      const energy     = af?.energy      ?? 0.5;
      const valence    = af?.valence     ?? 0.5;
      const tempo      = af?.tempo       ?? 138;
      const acoustic   = af?.acousticness ?? 0.25;
      const bassHeft   = energy * (1 - acoustic * 0.88);
      const speedMult  = Math.min(2.75, (tempo / 128) * (0.52 + energy * 1.05));
      const connectDist = 108 + energy * 140 + bassHeft * 24;

      // ── Beat detection ────────────────────────────────────────
      if (isPlayingRef.current && af?.beats && af.beats.length > 0) {
        const nowSec = progressRef.current / 1000;
        const idx    = af.beats.findIndex(
          (b) => b.start > nowSec - 0.05 && b.start <= nowSec + 0.05
        );
        if (idx !== -1 && idx !== lastBeatRef.current) {
          lastBeatRef.current = idx;
          beatFlashRef.current = 0.55 + bassHeft * 0.45;
          subFlashRef.current  = 0.28 + bassHeft * 0.62;
          onBeatRef.current?.();
        }
      }
      beatFlashRef.current = Math.max(0, beatFlashRef.current - dt * (5.2 + tempo / 220));
      subFlashRef.current  = Math.max(0, subFlashRef.current - dt * 3.8);

      ctx.clearRect(0, 0, W, H);

      // ── Beat flash overlay (full frame) ─────────────────────
      if (beatFlashRef.current > 0.01) {
        ctx.fillStyle = `rgba(184,255,44,${beatFlashRef.current * 0.065})`;
        ctx.fillRect(0, 0, W, H);
      }

      // ── Sub / bass floor wash (techno kick in the chest) ─────
      if (subFlashRef.current > 0.02) {
        const sub = subFlashRef.current;
        const g = ctx.createLinearGradient(0, H - 280, 0, H);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(0.45, `rgba(255,38,120,${sub * 0.07})`);
        g.addColorStop(1, `rgba(184,255,44,${sub * 0.055})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, H - 300, W, 300);
      }

      // ── Layer 1: Fog orbs (valence shifts hue) ─────────────────
      baseOrbs.forEach((orb) => {
        const hueShift = valence * 30;
        const ox = orb.cx * W + Math.sin(t * 0.07 + orb.phase) * W * 0.06;
        const oy = orb.cy * H + Math.cos(t * 0.05 + orb.phase) * H * 0.06;
        const rr = orb.r * Math.min(W, H);
        if (!isFinite(ox) || !isFinite(oy) || rr <= 0) return;

        const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, rr);
        grad.addColorStop(0,    `hsla(${orb.hue + hueShift}, ${orb.sat}%, 32%, 0.10)`);
        grad.addColorStop(0.45, `hsla(${orb.hue + hueShift}, ${orb.sat}%, 24%, 0.04)`);
        grad.addColorStop(1,    `hsla(${orb.hue + hueShift}, ${orb.sat}%, 16%, 0)`);

        ctx.beginPath();
        ctx.arc(ox, oy, rr, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      });

      // ── Layer 2: Node network (energy scales connectivity) ─────
      nodes.forEach((n) => {
        n.x += n.vx * (1 + energy * 0.5);
        n.y += n.vy * (1 + energy * 0.5);
        if (n.x < -20) n.x = W + 20;
        if (n.x > W + 20) n.x = -20;
        if (n.y < -20) n.y = H + 20;
        if (n.y > H + 20) n.y = -20;
      });

      ctx.lineWidth = 0.5;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx   = nodes[i].x - nodes[j].x;
          const dy   = nodes[i].y - nodes[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connectDist) {
            const strength = 1 - dist / connectDist;
            ctx.strokeStyle = `rgba(184,255,44,${strength * 0.08})`;
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.stroke();
          }
        }
      }

      nodes.forEach((n) => {
        const pulse = 0.85 + 0.15 * Math.sin(t * 0.8 + n.pulseOffset);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * pulse, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(184,255,44,${n.alpha * pulse})`;
        ctx.fill();
      });

      // ── Layer 3: Code rain (tempo scales speed) ───────────────
      ctx.font = `${CELL - 2}px "SF Mono", "Fira Code", "Courier New", monospace`;
      ctx.textAlign = "center";

      columns.forEach((col) => {
        col.y += col.speed * speedMult;

        col.charTimer++;
        if (col.charTimer >= col.charInterval) {
          col.charTimer = 0;
          col.trail.pop();
          col.trail.unshift(randChar());
          const mutIdx = 1 + Math.floor(Math.random() * (col.trail.length - 1));
          col.trail[mutIdx] = randChar();
        }

        if (col.y - col.trailLength * CELL > H) {
          col.y       = -CELL * 2;
          col.x       = (Math.random() * 0.8 + 0.1) * W;
          col.speed   = 0.4 + Math.random() * 0.7;
          col.opacity = 0.25 + Math.random() * 0.35;
        }

        col.trail.forEach((char, idx) => {
          const cy = col.y - idx * CELL;
          if (cy < -CELL || cy > H + CELL) return;

          if (idx === 0) {
            const bloom = ctx.createRadialGradient(col.x, cy, 0, col.x, cy, CELL * 1.2);
            bloom.addColorStop(0, `rgba(184,255,44,${col.opacity * 0.20})`);
            bloom.addColorStop(1, `rgba(184,255,44,0)`);
            ctx.fillStyle = bloom;
            ctx.fillRect(col.x - CELL * 1.2, cy - CELL * 1.2, CELL * 2.4, CELL * 2.4);
            ctx.fillStyle = `rgba(220,255,195,${col.opacity})`;
          } else {
            const alpha = col.opacity * Math.pow(0.78, idx) * 0.85;
            if (alpha < 0.008) return;
            ctx.fillStyle = `rgba(184,255,44,${alpha})`;
          }

          ctx.fillText(char, col.x, cy);
        });
      });

      // ── Layer 4: Scan lines ────────────────────────────────────
      ctx.fillStyle = "rgba(0,0,0,0.022)";
      for (let sy = 0; sy < H; sy += 4) ctx.fillRect(0, sy, W, 2);

      // top vignette
      const vignette = ctx.createLinearGradient(0, 0, 0, H * 0.30);
      vignette.addColorStop(0, "rgba(3,5,3,0.28)");
      vignette.addColorStop(1, "rgba(3,5,3,0)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, W, H * 0.30);
    }

    resize();
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }}
      aria-hidden="true"
    />
  );
}