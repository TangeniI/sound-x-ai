/**
 * TrackTimeline.tsx
 *
 * DAW-style piano-roll / timeline visualiser for the generated sequence.
 * Renders a scrolling canvas strip showing:
 *   - Generated MIDI notes as acid-green rectangles (pitch = y, time = x)
 *   - A playhead that advances in real-time
 *   - Beat markers at regular intervals
 *   - Track lanes (Melody / Chords / Drums) with left-side labels
 *
 * Props:
 *   sequence      — array of NoteEvent objects from Magenta engine
 *   isPlaying     — whether playback is active
 *   progressMs    — current playback position in ms
 *   durationMs    — total sequence duration in ms
 *   tempo         — BPM for beat markers
 */

import React,{ useEffect, useRef } from "react";

export interface NoteEvent {
  pitch:      number;  // MIDI 0-127
  startTime:  number;  // seconds
  endTime:    number;  // seconds
  velocity:   number;  // 0-127
  instrument: "melody" | "chords" | "drums";
}

interface Props {
  sequence?:   NoteEvent[];
  isPlaying?:  boolean;
  progressMs?: number;
  durationMs?: number;
  tempo?:      number;
}

const ACID      = "rgba(184,255,44,";
const LANE_H    = 64;          // px per track lane
const LANES     = ["MELODY", "CHORDS", "DRUMS"] as const;
const LABEL_W   = 60;          // px for lane labels

const LANE_COLORS: Record<string, string> = {
  MELODY: "rgba(184,255,44,",
  CHORDS: "rgba(44,220,255,",
  DRUMS:  "rgba(255,180,44,",
};

const LANE_INST: Record<string, NoteEvent["instrument"]> = {
  MELODY: "melody",
  CHORDS: "chords",
  DRUMS:  "drums",
};

function pitchToLaneY(pitch: number, laneIndex: number): number {
  // Map pitch 0-127 within a lane's vertical space
  const normalised = 1 - pitch / 127;
  return laneIndex * LANE_H + normalised * (LANE_H - 4) + 2;
}

export default function TrackTimeline({
  sequence = [],
  isPlaying = false,
  progressMs = 0,
  durationMs = 8000,
  tempo = 120,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);
  const scrollRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx    = canvas.getContext("2d")!;
    const H      = LANE_H * LANES.length;
    const W      = canvas.parentElement?.clientWidth ?? 640;
    canvas.width  = W;
    canvas.height = H;

    const CONTENT_W   = W - LABEL_W;
    const secPerPx    = durationMs / 1000 / CONTENT_W;
    const beatIntervalSec = 60 / tempo;
    const beatPx      = beatIntervalSec / secPerPx;

    let lastTime = performance.now();

    function draw(now: number) {
      rafRef.current = requestAnimationFrame(draw);
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      if (isPlaying) {
        // Smooth scroll: keep playhead at 30% of content width
        const playheadTarget = LABEL_W + CONTENT_W * 0.30;
        const playheadActual = LABEL_W + (progressMs / 1000 / secPerPx) - scrollRef.current;
        scrollRef.current += (playheadActual - playheadTarget) * Math.min(dt * 4, 1);
        scrollRef.current = Math.max(0, scrollRef.current);
      } else if (progressMs === 0) {
        // reset to the start of the arrangement when stopped
        scrollRef.current = 0;
      }

      ctx.clearRect(0, 0, W, H);

      // ── background ──────────────────────────────────────────────
      ctx.fillStyle = "rgba(3,6,3,0.92)";
      ctx.fillRect(0, 0, W, H);

      // ── lane backgrounds & separators ────────────────────────────
      LANES.forEach((lane, i) => {
        // alternating tint
        ctx.fillStyle = i % 2 === 0
          ? "rgba(184,255,44,0.015)"
          : "rgba(0,0,0,0.0)";
        ctx.fillRect(LABEL_W, i * LANE_H, CONTENT_W, LANE_H);

        // separator line
        ctx.strokeStyle = "rgba(184,255,44,0.08)";
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, (i + 1) * LANE_H - 0.5);
        ctx.lineTo(W, (i + 1) * LANE_H - 0.5);
        ctx.stroke();
      });

      // ── beat markers ──────────────────────────────────────────────
      const firstBeatX = LABEL_W + (0 - scrollRef.current);
      for (let b = 0; ; b++) {
        const bx = firstBeatX + b * beatPx;
        if (bx > W) break;
        if (bx < LABEL_W) continue;

        const isBar = b % 4 === 0;
        ctx.strokeStyle = `rgba(184,255,44,${isBar ? 0.14 : 0.05})`;
        ctx.lineWidth   = isBar ? 0.8 : 0.4;
        ctx.beginPath();
        ctx.moveTo(bx, 0);
        ctx.lineTo(bx, H);
        ctx.stroke();

        if (isBar) {
          ctx.font      = '7px "SF Mono", monospace';
          ctx.fillStyle = "rgba(184,255,44,0.22)";
          ctx.textAlign = "left";
          ctx.fillText(`${b / 4 + 1}`, bx + 2, 8);
        }
      }

      // ── note blocks ───────────────────────────────────────────────
      ctx.save();
      ctx.beginPath();
      ctx.rect(LABEL_W, 0, CONTENT_W, H);
      ctx.clip();

      sequence.forEach((note) => {
        const laneIdx = LANES.findIndex((l) => LANE_INST[l] === note.instrument);
        if (laneIdx === -1) return;

        const nx = LABEL_W + note.startTime / secPerPx - scrollRef.current;
        const nw = Math.max(2, (note.endTime - note.startTime) / secPerPx);
        const ny = pitchToLaneY(note.pitch, laneIdx);
        const nh = 4;

        if (nx + nw < LABEL_W || nx > W) return;

        const alpha = 0.3 + (note.velocity / 127) * 0.7;
        const col   = LANE_COLORS[LANES[laneIdx]];

        // shadow glow
        ctx.shadowColor = col + "0.8)";
        ctx.shadowBlur  = 4;
        ctx.fillStyle   = col + `${alpha})`;
        ctx.beginPath();
        ctx.roundRect?.(nx, ny, nw, nh, 1) ?? ctx.rect(nx, ny, nw, nh);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      ctx.restore();

      // ── playhead ──────────────────────────────────────────────────
      if (isPlaying || progressMs > 0) {
        const phX = LABEL_W + progressMs / 1000 / secPerPx - scrollRef.current;
        if (phX >= LABEL_W && phX <= W) {
          const grad = ctx.createLinearGradient(phX - 1, 0, phX + 1, 0);
          grad.addColorStop(0,   "rgba(184,255,44,0)");
          grad.addColorStop(0.5, "rgba(184,255,44,0.9)");
          grad.addColorStop(1,   "rgba(184,255,44,0)");
          ctx.strokeStyle = grad;
          ctx.lineWidth   = 2;
          ctx.beginPath();
          ctx.moveTo(phX, 0);
          ctx.lineTo(phX, H);
          ctx.stroke();

          // playhead triangle
          ctx.fillStyle = ACID + "0.9)";
          ctx.beginPath();
          ctx.moveTo(phX - 4, 0);
          ctx.lineTo(phX + 4, 0);
          ctx.lineTo(phX,     7);
          ctx.closePath();
          ctx.fill();
        }
      }

      // ── lane labels (left sidebar) ────────────────────────────────
      LANES.forEach((lane, i) => {
        const lx = LABEL_W / 2;
        const ly = i * LANE_H + LANE_H / 2;
        const col = LANE_COLORS[lane];

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(-Math.PI / 2);
        ctx.font      = '7px "SF Mono", "Fira Code", monospace';
        ctx.fillStyle = col + "0.45)";
        ctx.textAlign = "center";
        ctx.fillText(lane, 0, 0);
        ctx.restore();

        // vertical divider
        ctx.strokeStyle = ACID + "0.08)";
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        ctx.moveTo(LABEL_W - 0.5, i * LANE_H);
        ctx.lineTo(LABEL_W - 0.5, (i + 1) * LANE_H);
        ctx.stroke();
      });

      // ── empty state ───────────────────────────────────────────────
      if (sequence.length === 0) {
        ctx.font      = '9px "SF Mono", "Fira Code", monospace';
        ctx.fillStyle = "rgba(184,255,44,0.18)";
        ctx.textAlign = "center";
        ctx.fillText("[ AWAITING GENERATION ]", W / 2 + LABEL_W / 2, H / 2);
      }
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [sequence, isPlaying, progressMs, durationMs, tempo]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{
        fontFamily:    '"SF Mono", "Fira Code", monospace',
        fontSize:      9,
        letterSpacing: "0.28em",
        color:         "rgba(184,255,44,0.35)",
      }}>
        // TRACK.TIMELINE
      </div>
      <div style={{
        border:        "1px solid rgba(184,255,44,0.08)",
        borderRadius:  10,
        overflow:      "hidden",
      }}>
        <canvas ref={canvasRef} style={{ display: "block", width: "100%" }} />
      </div>
    </div>
  );
}