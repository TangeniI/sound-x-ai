/**
 * NowPlaying.tsx
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AudioFeatures, NowPlayingData } from "../types";

function PlayingBars({ active }: { active: boolean }) {
  return (
    <span aria-label={active ? "Now playing" : "Last played"}
      style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 14 }}>
      {[0.6, 1, 0.4, 0.8, 0.55].map((h, i) => (
        <span key={i} style={{
          display: "inline-block", width: 2.5,
          height: active ? `${h * 100}%` : "30%",
          background: active ? "var(--acid, #b8ff2c)" : "rgba(255,255,255,0.30)",
          borderRadius: 2, transformOrigin: "bottom",
          animation: active ? `barPulse ${0.5 + i * 0.12}s ease-in-out ${i * 0.08}s infinite alternate` : "none",
          transition: "height 0.3s ease",
        }} />
      ))}
      <style>{`@keyframes barPulse { from{transform:scaleY(0.4)} to{transform:scaleY(1)} }`}</style>
    </span>
  );
}

function ProgressBar({ progress, duration, isPlaying }: { progress: number; duration: number; isPlaying: boolean }) {
  const pct = Math.min((progress / duration) * 100, 100);
  return (
    <div style={{ height: 2, background: "rgba(255,255,255,0.10)", borderRadius: 2, overflow: "hidden", marginTop: 10 }}>
      <motion.div
        initial={{ width: `${pct}%` }}
        animate={{ width: isPlaying ? "100%" : `${pct}%` }}
        transition={isPlaying ? { duration: (duration - progress) / 1000, ease: "linear" } : { duration: 0.3 }}
        style={{ height: "100%", background: "linear-gradient(90deg, rgba(184,255,44,0.7), rgba(184,255,44,1))", borderRadius: 2 }}
      />
    </div>
  );
}

function SpotifyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="12" fill="#1DB954" />
      <path d="M16.9 10.75c-2.7-1.6-7.15-1.75-9.73-.97-.41.13-.85-.1-.98-.51a.78.78 0 0 1 .51-.98c2.96-.9 7.88-.72 10.99 1.12.38.22.5.71.28 1.08a.78.78 0 0 1-1.07.26zm-.12 3.02a.65.65 0 0 1-.9.22c-2.25-1.39-5.67-1.79-8.33-1a.65.65 0 1 1-.38-1.24c3.03-.93 6.8-.47 9.39 1.12a.65.65 0 0 1 .22.9zm-1.02 2.91a.52.52 0 0 1-.72.17c-1.96-1.2-4.43-1.47-7.34-.8a.52.52 0 0 1-.24-1.01c3.18-.73 5.91-.41 8.13.92a.52.52 0 0 1 .17.72z" fill="white" />
    </svg>
  );
}

const cardStyle: CSSProperties = {
  padding: "14px 16px", borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.09)",
  background: "rgba(6,9,6,0.70)",
  backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)",
  boxShadow: "0 20px 80px rgba(0,0,0,0.55)",
  minWidth: 240, maxWidth: 340, fontFamily: "var(--sans)",
};
const artStyle: CSSProperties = { width: 52, height: 52, borderRadius: 10 };
const labelStyle: CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.24em",
  textTransform: "uppercase" as const, color: "rgba(255,255,255,0.32)",
};

export type PlaybackPayload = { progressMs: number; isPlaying: boolean };

export default function NowPlaying({
  onAudioFeatures,
  onPlayback,
}: {
  onAudioFeatures?: (f: AudioFeatures | null) => void;
  onPlayback?:     (p: PlaybackPayload) => void;
}) {
  const [data,    setData]    = useState<NowPlayingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const lastTrackId           = useRef<string | null>(null);
  const syncRef               = useRef({ progress: 0, t0: 0 });
  const onPlaybackRef         = useRef(onPlayback);
  onPlaybackRef.current       = onPlayback;

  const fetchNowPlaying = async () => {
    try {
      const res  = await fetch("/api/spotify?action=now-playing");
      if (!res.ok) throw new Error("API error");
      const json = await res.json() as NowPlayingData;
      setData(json);
      setError(false);
      if (json.isPlaying && json.track) {
        syncRef.current = {
          progress: json.progress ?? 0,
          t0:       performance.now(),
        };
      }
      if (json.track && json.track.id !== lastTrackId.current) {
        lastTrackId.current = json.track.id;
        if (onAudioFeatures) {
          fetch(`/api/spotify?action=audio-analysis&id=${json.track.id}`)
            .then((r) => r.json())
            .then((f: AudioFeatures) => onAudioFeatures(f))
            .catch(() => onAudioFeatures(null));
        }
      }
    } catch { setError(true); }
    finally  { setLoading(false); }
  };

  useEffect(() => {
    void fetchNowPlaying();
  }, []);

  useEffect(() => {
    if (loading) return;
    const ms = data?.isPlaying ? 4_000 : 28_000;
    const id = setInterval(() => void fetchNowPlaying(), ms);
    return () => clearInterval(id);
  }, [loading, data?.isPlaying]);

  useEffect(() => {
    if (loading) return;
    if (!data?.isPlaying || !data.track) {
      onPlaybackRef.current?.({ progressMs: data?.progress ?? 0, isPlaying: false });
      return;
    }
    let raf = 0;
    const tick = () => {
      const { progress, t0 } = syncRef.current;
      const elapsed = performance.now() - t0;
      onPlaybackRef.current?.({ progressMs: progress + elapsed, isPlaying: true });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loading, data?.isPlaying, data?.track?.id, data?.progress]);

  if (loading) return (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ ...artStyle, background: "rgba(255,255,255,0.06)", flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ height: 10, width: "60%", borderRadius: 4, background: "rgba(255,255,255,0.07)", marginBottom: 8 }} />
          <div style={{ height: 9, width: "40%", borderRadius: 4, background: "rgba(255,255,255,0.05)" }} />
        </div>
      </div>
    </div>
  );

  if (error || !data?.track) return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SpotifyIcon />
        <span style={labelStyle}>{error ? "Couldn't load Spotify data" : "Nothing playing right now"}</span>
      </div>
    </div>
  );

  const { isPlaying, progress = 0, track } = data;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={track.id}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
        style={cardStyle}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <SpotifyIcon />
            <span style={labelStyle}>{isPlaying ? "Now playing" : "Last played"}</span>
          </div>
          <PlayingBars active={isPlaying} />
        </div>

        <a href={track.url} target="_blank" rel="noreferrer"
          style={{ display: "flex", gap: 12, alignItems: "center", textDecoration: "none" }}>
          <motion.div whileHover={{ scale: 1.04 }} style={{
            ...artStyle, flexShrink: 0, overflow: "hidden",
            background: "rgba(255,255,255,0.06)",
            boxShadow: isPlaying ? "0 0 28px rgba(184,255,44,0.18), 0 8px 24px rgba(0,0,0,0.55)" : "0 8px 24px rgba(0,0,0,0.55)",
            transition: "box-shadow 0.4s ease",
          }}>
            {track.albumArt
              ? <img src={track.albumArt} alt={`${track.album} cover`} crossOrigin="anonymous"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", borderRadius: 10 }} />
              : <div style={{ width: "100%", height: "100%", background: "rgba(255,255,255,0.08)", borderRadius: 10 }} />
            }
          </motion.div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: "rgba(232,255,235,0.92)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 3 }}>
              {track.title}
            </div>
            <div style={{ fontSize: 11.5, color: "rgba(232,255,235,0.48)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {track.artist}
            </div>
            <div style={{ fontSize: 10.5, color: "rgba(232,255,235,0.28)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {track.album}
            </div>
          </div>
        </a>

        {isPlaying && track.duration > 0 && (
          <ProgressBar progress={progress} duration={track.duration} isPlaying={isPlaying} />
        )}
      </motion.div>
    </AnimatePresence>
  );
}