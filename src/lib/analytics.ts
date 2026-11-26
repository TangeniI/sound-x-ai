/**
 * lib/analytics.ts
 *
 * Anonymous counts, so we can tell whether anyone plays, exports or comes back.
 * Visits are counted by Vercel Web Analytics in production builds: no cookies,
 * no personal data. Its free plan counts pages, not events, so the events go to
 * GoatCounter, also cookieless, which is off unless VITE_GOATCOUNTER is set at
 * build time (its count URL). Neither counts development.
 *
 * Events are counted as paths like "event/export-midi". The funnel we watch:
 * visit → listened-30s → export-* → return-*.
 */

const ENDPOINT = import.meta.env.VITE_GOATCOUNTER as string | undefined;

declare global {
  interface Window {
    goatcounter?: { count?: (v: { path: string; title?: string; event?: boolean }) => void; no_onload?: boolean };
    va?: (...args: unknown[]) => void;
    vaq?: unknown[][];
  }
}

const queue: string[] = [];
let started = false;

/** Vercel's visit counter, served by the deployment itself. */
function startVercel(): void {
  if (!import.meta.env.PROD || typeof document === "undefined" || location.hostname === "localhost") return;
  window.va = window.va || ((...args: unknown[]) => { (window.vaq = window.vaq || []).push(args); });
  const s = document.createElement("script");
  s.defer = true;
  s.src = "/_vercel/insights/script.js";
  document.head.appendChild(s);
}

/** Load the counters (which also count the page view) and record a return visit. */
export function startAnalytics(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  startVercel();
  if (!ENDPOINT) return;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.dataset.goatcounter = ENDPOINT;
  s.onload = () => { for (const e of queue.splice(0)) send(e); };
  document.head.appendChild(s);
  const back = returnVisit();
  if (back) track(back);
}

function send(event: string): void {
  window.goatcounter?.count?.({ path: `event/${event}`, title: event, event: true });
}

/** Count one thing someone did. Safe to call when analytics is off. */
export function track(event: string): void {
  if (!ENDPOINT) return;
  if (window.goatcounter?.count) send(event);
  else queue.push(event);
}

const once = new Set<string>();
/** Count something at most once per page load. */
export function trackOnce(event: string): void {
  if (once.has(event)) return;
  once.add(event);
  track(event);
}

const FIRST = "soundxai.first.v1";
const LAST = "soundxai.last.v1";
const DAY = 86_400_000;

/**
 * Which return bucket this visit falls in, if any. Kept in this browser only: the
 * day of the first visit and the last one counted, so a return is counted once a day.
 */
export function returnVisit(now = Date.now(), store: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string | null {
  if (!store) return null;
  const today = Math.floor(now / DAY);
  const first = Number(store.getItem(FIRST));
  const last = Number(store.getItem(LAST));
  if (!first) {
    store.setItem(FIRST, String(today));
    store.setItem(LAST, String(today));
    return null;
  }
  if (last === today) return null;
  store.setItem(LAST, String(today));
  const days = today - first;
  if (days <= 0) return null;
  return days <= 7 ? "return-1-7d" : days <= 30 ? "return-8-30d" : "return-31d-plus";
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
