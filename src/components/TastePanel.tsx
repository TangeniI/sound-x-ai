/**
 * TastePanel.tsx
 *
 * Opt in to Randomise learning from what you keep and skip, see what it has
 * learned, and how well it predicts takes it hasn't seen. All of it stays here.
 */

import { useMemo } from "react";
import type { Studio } from "../hooks/useStudio";
import { FAMILIES } from "../lib/groove/families";
import { evaluate, KEEP_HEARD, keepRate, learn } from "../lib/taste";

/** Takes needed before the held-out test has enough to say anything. */
const NEEDED = 50;

export function TastePanel({ studio }: { studio: Studio }) {
  const { on, events } = studio.taste;
  const result = useMemo(() => evaluate(events), [events]);
  const favourites = useMemo(() => {
    const t = learn(events);
    return FAMILIES
      .filter((f) => events.filter((e) => e.family === f.id).length >= 3 && events.some((e) => e.family === f.id && e.outcome !== "skip"))
      .map((f) => ({ name: f.name, rate: keepRate(t, f.id) }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 3);
  }, [events]);
  const count = (o: string) => events.filter((e) => e.outcome === o).length;

  return (
    <div className="taste" role="group" aria-label="Taste">
      <span className="levels-head">Taste</span>
      <label className="taste-on">
        <input type="checkbox" checked={on} onChange={(e) => studio.setTasteOn(e.target.checked)} />
        Let Randomise learn from what I keep and skip
      </label>
      <p className="taste-note">
        A Groove take counts as kept when you export it, change it, or play it for {KEEP_HEARD} seconds,
        and as skipped when you move on sooner. Randomise then leans towards the families and settings
        you keep. Families you haven't heard yet still come up until it knows how you take them, and one
        pick in five is at random whatever it has learned. Kept in this browser only; nothing is sent.
      </p>
      {events.length > 0 && (
        <>
          <p className="taste-note">
            {events.length} takes: {count("export")} exported, {count("keep")} kept, {count("skip")} skipped.
            {favourites.length > 0 && <> Kept most: {favourites.map((f) => `${f.name} (${Math.round(f.rate * 100)}%)`).join(", ")}.</>}
          </p>
          <p className="taste-note">
            {result.enough
              ? <>Tested on your latest {result.test} takes, which it didn't learn from: {result.model < result.baseline
                  ? <>it predicts keeps better than your overall keep rate does (log loss {result.model.toFixed(2)} against {result.baseline.toFixed(2)}, AUC {result.auc.toFixed(2)}).</>
                  : <>it doesn't yet predict keeps better than your overall keep rate (log loss {result.model.toFixed(2)} against {result.baseline.toFixed(2)}).</>}</>
              : <>About {Math.max(1, NEEDED - events.length)} more takes and it can test itself on ones it hasn't seen.</>}
          </p>
          <div className="taste-actions">
            <button className="chip" onClick={studio.exportTaste} title="Your keeps and skips as JSON">Download data</button>
            <button className="chip" onClick={studio.forgetTaste}>Forget</button>
          </div>
        </>
      )}
    </div>
  );
}
