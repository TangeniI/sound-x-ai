import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { NeuralRiff, type ModelJSON } from "./neural-engine";

const model = JSON.parse(readFileSync("public/model/riff-gru.json", "utf8")) as ModelJSON;
const fixture = JSON.parse(readFileSync("ml/parity_fixture.json", "utf8")) as { riffs: number[][]; nats: number };

function rngFrom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("riff GRU", () => {
  const net = new NeuralRiff();
  net.use(model);

  it("matches the Python model on held-out riffs", () => {
    expect(net.score(fixture.riffs)).toBeCloseTo(fixture.nats, 3);
  });

  it("returns a valid distribution for every step", () => {
    const s = net.sample(32, 0.8, rngFrom(1));
    expect(s.tokens).toHaveLength(32);
    for (const p of s.probs) {
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(p[model.bos]).toBe(0);
    }
  });

  it("is repeatable from the same random stream", () => {
    expect(net.sample(32, 0.8, rngFrom(5)).tokens).toEqual(net.sample(32, 0.8, rngFrom(5)).tokens);
  });

  it("lets a held note change what the model plays next", () => {
    const free = net.sample(32, 0.8, rngFrom(9));
    const token = model.vocab.indexOf(7);
    const held = net.sample(32, 0.8, rngFrom(9), { 4: token });
    expect(held.tokens[4]).toBe(token);
    expect(held.tokens.slice(0, 4)).toEqual(free.tokens.slice(0, 4));
    expect(held.probs[5]).not.toEqual(free.probs[5]);
  });
});
