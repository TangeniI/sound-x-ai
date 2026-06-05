/**
 * CharacterDisplay.tsx
 *
 * Pixel raver tuned for techno / four-on-the-floor:
 *   alternating weight shift, kick dip + squash (bass-weighted), every-4 downbeat,
 *   BPM-scaled timing for 130–160+ BPM, low “ride the breakdown” stance when sparse.
 */

import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";

export interface AudioFeatures {
  tempo:        number;
  energy:       number;
  valence:      number;
  danceability: number;
  acousticness: number;
}

interface Props {
  beatCount?:     number;
  isPlaying?:     boolean;
  audioFeatures?: AudioFeatures | null;
}

const PX = 4;
type Rect = [number, number, number, number];

function drawPixels(pixels: Rect[], fill: string) {
  return pixels.map(([x, y, w, h], i) => (
    <rect key={i} x={x * PX} y={y * PX} width={w * PX} height={h * PX} fill={fill} />
  ));
}

const ACID   = "#b8ff2c";
const DIM    = "#7ab81e";
const DARK   = "#1a2600";
const WHITE  = "#dcffc3";

const HEAD: Rect[] = [[13, 2, 6, 6]];
const FACE: Rect[] = [
  [14, 4, 1, 1],
  [17, 4, 1, 1],
  [15, 6, 2, 1],
];
const VISOR: Rect[] = [[13, 3, 6, 2]];

function IdleFrame() {
  return (
    <>
      {drawPixels(HEAD, ACID)}
      {drawPixels(VISOR, DARK)}
      {drawPixels(FACE, WHITE)}
      {drawPixels([[14, 8, 4, 7]], ACID)}
      {drawPixels([[15, 9, 2, 5]], DIM)}
      {drawPixels([[11, 8, 3, 2], [10, 10, 3, 2], [11, 12, 2, 2]], DIM)}
      {drawPixels([[18, 8, 3, 2], [19, 10, 3, 2], [19, 12, 2, 2]], DIM)}
      {drawPixels([[14, 15, 2, 5], [14, 20, 2, 3]], ACID)}
      {drawPixels([[17, 15, 2, 5], [17, 20, 2, 3]], ACID)}
      {drawPixels([[13, 23, 4, 2]], DIM)}
      {drawPixels([[17, 23, 4, 2]], DIM)}
    </>
  );
}

function CrouchFrame() {
  return (
    <>
      {drawPixels([[13, 10, 6, 6]], ACID)}
      {drawPixels([[13, 11, 6, 2]], DARK)}
      {drawPixels([[14, 12, 1, 1], [17, 12, 1, 1]], WHITE)}
      {drawPixels([[14, 16, 4, 4]], ACID)}
      {drawPixels([[15, 17, 2, 2]], DIM)}
      {drawPixels([[10, 16, 4, 2], [10, 18, 3, 2]], DIM)}
      {drawPixels([[18, 16, 4, 2], [19, 18, 3, 2]], DIM)}
      {drawPixels([[14, 20, 2, 3], [12, 23, 4, 2]], ACID)}
      {drawPixels([[17, 20, 2, 3], [17, 23, 4, 2]], ACID)}
    </>
  );
}

function VictoryFrame() {
  return (
    <>
      {drawPixels(HEAD, ACID)}
      {drawPixels(VISOR, DARK)}
      {drawPixels([[14, 4, 1, 1], [17, 4, 1, 1], [15, 6, 2, 1]], WHITE)}
      {drawPixels([[14, 8, 4, 7]], ACID)}
      {drawPixels([[15, 9, 2, 5]], DIM)}
      {drawPixels([[10, 6, 3, 3], [9, 3, 2, 4]], DIM)}
      {drawPixels([[19, 6, 3, 3], [21, 3, 2, 4]], DIM)}
      {drawPixels([[9, 1, 2, 2]], WHITE)}
      {drawPixels([[21, 1, 2, 2]], WHITE)}
      {drawPixels([[14, 15, 2, 5], [14, 20, 2, 3]], ACID)}
      {drawPixels([[17, 15, 2, 5], [17, 20, 2, 3]], ACID)}
      {drawPixels([[13, 23, 4, 2]], DIM)}
      {drawPixels([[17, 23, 4, 2]], DIM)}
    </>
  );
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

export default function CharacterDisplay({ beatCount = 0, isPlaying, audioFeatures }: Props) {
  const [intro, setIntro]     = useState(false);
  const [label, setLabel]     = useState("IDLE");
  const prevBeatRef           = useRef(-1);
  const bodyCtrl              = useAnimationControls();
  const floorCtrl             = useAnimationControls();

  const bpm      = clamp(audioFeatures?.tempo ?? 138, 118, 185);
  const beatSec  = 60 / bpm;
  const energy   = audioFeatures?.energy ?? 0.55;
  const dance    = audioFeatures?.danceability ?? 0.55;
  const acoustic = audioFeatures?.acousticness ?? 0.25;
  const bassHeft = energy * (1 - acoustic * 0.85);

  const breakdown = Boolean(isPlaying && energy < 0.42 && acoustic > 0.38);

  useEffect(() => {
    if (!isPlaying) {
      setIntro(false);
      setLabel("IDLE");
      void bodyCtrl.start({ x: 0, y: 0, rotate: 0, scaleY: 1, scaleX: 1, transition: { duration: 0.35 } });
      void floorCtrl.start({ scaleX: 1, opacity: 0.35, transition: { duration: 0.4 } });
      return;
    }
    setIntro(true);
    setLabel("LOCKED");
    void bodyCtrl.start({ x: 0, y: 0, rotate: 0, scaleY: 1, scaleX: 1, transition: { duration: 0.15 } });
    const t = window.setTimeout(() => setIntro(false), 900);
    return () => clearTimeout(t);
  }, [isPlaying, bodyCtrl, floorCtrl]);

  useEffect(() => {
    if (!isPlaying || intro || breakdown) return;
    if (beatCount === prevBeatRef.current) return;
    prevBeatRef.current = beatCount;

    const side       = beatCount % 2 === 0 ? -1 : 1;
    const downbeat   = beatCount % 4 === 0;
    const hitDur     = clamp(beatSec * 0.38, 0.07, 0.16);
    const recoverDur = clamp(beatSec * 0.55, 0.1, 0.22);
    const total      = hitDur + recoverDur;

    const sway = side * (4 + dance * 9 + Math.min(18, (bpm - 128) * 0.15));
    const dip  = 2.5 + bassHeft * 9 + (downbeat ? 3.2 : 0);
    const lean = side * (1.2 + dance * 2.2);

    setLabel(downbeat ? "KICK" : "STEP");

    void bodyCtrl.start({
      x:        [sway * 0.15, sway, sway * 0.35],
      y:        [0, dip, 0],
      rotate:   [lean * 0.2, lean, lean * 0.35],
      scaleY:   [1, 0.9 - bassHeft * 0.07, 1],
      scaleX:   [1, 1.03 + bassHeft * 0.04, 1],
      transition: {
        duration: total,
        times:    [0, hitDur / total, 1],
        ease:     ["easeOut", "easeInOut"],
      },
    });

    void floorCtrl.start({
      scaleX:  [1, 1.12 + bassHeft * 0.2, 1],
      opacity: [0.35, 0.65 + bassHeft * 0.25, 0.35],
      transition: {
        duration: total,
        times:    [0, hitDur / total, 1],
        ease:     ["easeOut", "easeInOut"],
      },
    });
  }, [beatCount, isPlaying, intro, breakdown, bpm, beatSec, bassHeft, dance, bodyCtrl, floorCtrl]);

  useEffect(() => {
    if (!breakdown || !isPlaying || intro) return;
    setLabel("RIDE");
    prevBeatRef.current = -1;
    void bodyCtrl.start({
      y:        [0, 2.5, 0],
      rotate:   [0, 1.8, 0],
      x:        [-2.5, 2.5, -2.5],
      scaleY:   [1, 0.96, 1],
      scaleX:   1,
      transition: { duration: beatSec * 2, repeat: Infinity, ease: "easeInOut" },
    });
    void floorCtrl.start({
      scaleX:  [1, 1.06, 1],
      opacity: [0.3, 0.45, 0.3],
      transition: { duration: beatSec * 2, repeat: Infinity, ease: "easeInOut" },
    });
  }, [breakdown, isPlaying, intro, beatSec, bodyCtrl, floorCtrl]);

  const QUIPS: Record<string, string> = {
    IDLE:   "booting… feed me a track",
    LOCKED: "locked to the grid",
    KICK:   "ride the kick",
    STEP:   "in the pocket",
    RIDE:   "breakdown… here it comes",
  };

  const W_SVG = 32 * PX;
  const H_SVG = 26 * PX;

  const idleBreath = {
    y:        [0, -1.2, 0],
    transition: {
      duration: clamp(beatSec * 8, 1.8, 3.6),
      repeat:   Infinity,
      ease:     "easeInOut" as const,
    },
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div style={{
        fontFamily:    "var(--mono)",
        fontSize:      11,
        fontWeight:    700,
        letterSpacing: "0.28em",
        color:         isPlaying ? ACID : "rgba(184,255,44,0.6)",
        transition:    "color 0.15s",
      }}>
        REZ<span style={{ color: "rgba(184,255,44,0.3)" }}>-909</span>
        <span style={{
          fontSize: 7.5,
          fontWeight: 400,
          letterSpacing: "0.2em",
          color: isPlaying ? "rgba(184,255,44,0.45)" : "rgba(184,255,44,0.25)",
          marginLeft: 8,
        }}>
          {label}
        </span>
      </div>

      <div style={{ position: "relative", width: W_SVG + 48, height: H_SVG + 28 }}>
        <motion.div
          style={{
            position:   "absolute",
            left:       "50%",
            bottom:     4,
            width:      W_SVG * 0.85,
            height:     8,
            marginLeft: -(W_SVG * 0.85) / 2,
            borderRadius: 6,
            background:   "radial-gradient(ellipse 80% 100% at 50% 50%, rgba(184,255,44,0.45), transparent)",
            filter:       "blur(4px)",
            pointerEvents: "none",
          }}
          initial={{ scaleX: 1, opacity: 0.35 }}
          animate={floorCtrl}
        />

        <motion.div
          style={{
            position: "relative",
            width:    W_SVG,
            height:   H_SVG,
            margin:   "0 auto",
            transformOrigin: "50% 92%",
          }}
          animate={bodyCtrl}
        >
          {breakdown ? (
            <svg
              width={W_SVG}
              height={H_SVG}
              viewBox={`0 0 ${W_SVG} ${H_SVG}`}
              style={{ imageRendering: "pixelated", overflow: "visible", display: "block" }}
            >
              <CrouchFrame />
            </svg>
          ) : (
            <motion.svg
              width={W_SVG}
              height={H_SVG}
              viewBox={`0 0 ${W_SVG} ${H_SVG}`}
              style={{ imageRendering: "pixelated", overflow: "visible", display: "block" }}
              animate={
                intro
                  ? { y: [0, -4, 0], transition: { duration: 0.45, repeat: 1, ease: "easeInOut" } }
                  : !isPlaying
                    ? { y: [0, -2, 0], transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" } }
                    : idleBreath
              }
            >
              {intro ? <VictoryFrame /> : <IdleFrame />}
            </motion.svg>
          )}
        </motion.div>
      </div>

      <div style={{
        fontFamily:    "var(--mono)",
        fontSize:      8,
        color:         "rgba(184,255,44,0.22)",
        letterSpacing: "0.2em",
        textAlign:     "center",
        lineHeight:    1.6,
      }}>
        <span style={{ color: "rgba(184,255,44,0.5)", letterSpacing: "0.15em" }}>
          “{QUIPS[label] ?? "…"}”
        </span>
        <br />
        4/4 · {Math.round(bpm)} BPM · BEAT {String(beatCount % 999).padStart(3, "0")}
      </div>
    </div>
  );
}
