/**
 * lib/share.ts
 *
 * Encode/decode a generator config in the URL query string, so a track's
 * "recipe" is shareable as a permalink — zero backend required.
 */

import type { GeneratorConfig, StyleId } from "../types";

const STYLES: StyleId[] = ["driving", "hypnotic", "acid", "melodic"];

export function encodeConfig(cfg: GeneratorConfig): string {
  const p = new URLSearchParams();
  p.set("s", cfg.style);
  p.set("b", String(cfg.bars));
  p.set("t", String(cfg.tempo));
  p.set("e", cfg.energy.toFixed(2));
  p.set("v", cfg.valence.toFixed(2));
  p.set("d", cfg.density.toFixed(2));
  p.set("x", cfg.variation.toFixed(2));
  p.set("k", String(cfg.rootPitch));
  return p.toString();
}

export function shareURL(cfg: GeneratorConfig): string {
  const url = new URL(window.location.href);
  url.search = encodeConfig(cfg);
  url.hash = "";
  return url.toString();
}

/** Parse a partial config from a query string (defaults to the current URL). */
export function parseConfigFromURL(search?: string): Partial<GeneratorConfig> {
  const q = search ?? (typeof window !== "undefined" ? window.location.search : "");
  const p = new URLSearchParams(q);
  const out: Partial<GeneratorConfig> = {};

  const s = p.get("s");
  if (s && STYLES.includes(s as StyleId)) out.style = s as StyleId;

  const int = (k: string, lo: number, hi: number) => {
    const v = p.get(k);
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
  };
  const flt = (k: string) => {
    const v = p.get(k);
    if (v == null) return undefined;
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : undefined;
  };

  const b = int("b", 4, 16); if (b != null) out.bars = b;
  const t = int("t", 90, 175); if (t != null) out.tempo = t;
  const k = int("k", 0, 11); if (k != null) out.rootPitch = k;
  const e = flt("e"); if (e != null) out.energy = e;
  const v = flt("v"); if (v != null) out.valence = v;
  const d = flt("d"); if (d != null) out.density = d;
  const x = flt("x"); if (x != null) out.variation = x;
  return out;
}

/* ── persist the last-used config between visits (localStorage) ──────── */

const LS_KEY = "soundxai.config";

export function saveConfig(cfg: Partial<GeneratorConfig>): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

export function loadSavedConfig(): Partial<GeneratorConfig> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<GeneratorConfig>) : {};
  } catch {
    return {};
  }
}
