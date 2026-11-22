import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./generative-engine";
import { commit, deserialise, redo, serialise, startHistory, undo, type Snapshot } from "./history";

const snap = (seed: number, over = {}): Snapshot => ({ config: { ...DEFAULT_CONFIG, seed, ...over }, edits: [] });

describe("history", () => {
  it("undoes and redoes", () => {
    const h = commit(startHistory(snap(1)), snap(2));
    expect(undo(h).now).toEqual(snap(1));
    expect(redo(undo(h)).now).toEqual(snap(2));
  });

  it("does nothing at either end", () => {
    const h = startHistory(snap(1));
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("makes one drag one step, and a later drag another", () => {
    let h = startHistory(snap(1));
    h = commit(h, snap(1, { energy: 0.5 }), "energy", 1000);
    h = commit(h, snap(1, { energy: 0.6 }), "energy", 1200);
    expect(h.past).toHaveLength(1);
    h = commit(h, snap(1, { energy: 0.7 }), "energy", 3000);
    expect(h.past).toHaveLength(2);
  });

  it("doesn't lose a take when a change replaces the redo branch", () => {
    const h = commit(undo(commit(startHistory(snap(1)), snap(2))), snap(3));
    expect(h.future).toEqual([]);
    expect(h.takes.map((t) => t.config.seed).sort()).toEqual([1, 2, 3]);
  });

  it("keeps the last state of a take, edits and all", () => {
    const edited: Snapshot = { ...snap(1), edits: [{ op: "add", lane: "bass", step: 3, pitch: 33, root: 9 }] };
    const h = commit(commit(startHistory(snap(1)), edited), snap(2));
    expect(h.takes.find((t) => t.config.seed === 1)).toEqual(edited);
  });

  it("keeps edits that were undone before a change", () => {
    const edited: Snapshot = { ...snap(2), edits: [{ op: "add", lane: "bass", step: 3, pitch: 33, root: 9 }] };
    const made = commit(commit(startHistory(snap(1)), snap(2)), edited);

    // undone back past the take, then changed: the take still has its edits
    const across = commit(undo(undo(made)), snap(1, { energy: 0.2 }));
    expect(across.takes.find((t) => t.config.seed === 2)).toEqual(edited);

    // undone inside the take, then changed: undo can still get back to them
    let h = commit(undo(made), snap(2, { energy: 0.2 }));
    expect(undo(h).now).toEqual(snap(2));
    h = undo(undo(h));
    expect(h.now).toEqual(edited);
  });

  it("comes back whole after a reload", () => {
    const now: Snapshot = { ...snap(2, { family: "signal", laneSeeds: { bass: 2 }, pins: { 4: 12 } }), edits: [{ op: "remove", lane: "bass", step: 18, pitch: 33, root: 9 }] };
    const h = undo(commit(commit(startHistory(snap(1)), now), snap(3)));
    const back = deserialise(serialise(h), DEFAULT_CONFIG)!;
    expect(back.now).toEqual(h.now);
    expect(back.past).toEqual(h.past);
    expect(back.future).toEqual(h.future);
    expect(back.takes).toEqual(h.takes);
  });

  it("ignores a broken saved session", () => {
    for (const text of [null, "", "{", "{}", '{"now":"s=polka"}']) expect(deserialise(text, DEFAULT_CONFIG)).toBeNull();
  });
});
