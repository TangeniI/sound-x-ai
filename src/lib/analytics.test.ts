import { describe, expect, it } from "vitest";
import { returnVisit, track } from "./analytics";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const DAY = 86_400_000;
const day0 = Date.UTC(2026, 10, 23, 12);

describe("analytics", () => {
  it("counts a return once a day, in buckets from the first visit", () => {
    const store = memory();
    expect(returnVisit(day0, store)).toBeNull();               // first visit
    expect(returnVisit(day0 + 3600_000, store)).toBeNull();    // same day
    expect(returnVisit(day0 + 2 * DAY, store)).toBe("return-1-7d");
    expect(returnVisit(day0 + 2 * DAY + 60_000, store)).toBeNull(); // once that day
    expect(returnVisit(day0 + 12 * DAY, store)).toBe("return-8-30d");
    expect(returnVisit(day0 + 40 * DAY, store)).toBe("return-31d-plus");
  });

  it("does nothing when storage is blocked, or when analytics is off", () => {
    expect(returnVisit(day0, null)).toBeNull();
    expect(() => track("export-midi")).not.toThrow();
  });
});
