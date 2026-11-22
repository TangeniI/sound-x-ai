/**
 * lib/groove/parts.ts
 *
 * Chooses the parts of a Groove take from its family, and turns down weak
 * combinations. The choice depends only on the seed and the re-rolled parts, so
 * a slider shapes a take without replacing it.
 */

import { hitNoise, laneSeed, makeRng, variantOf } from "../writing";
import type { GeneratorConfig, Lane } from "../../types";
import { FAMILIES, familyById, HATS, type Family } from "./families";

export const strip = (line: string) => line.replace(/\s+/g, "");
export const hitAt = (line: string, step: number) => line[step % line.length];

/** Which steps of two bars a pattern plays on. */
function steps(line: string, kinds = "xo-htu"): number[] {
  if (!line) return [];
  return Array.from({ length: 32 }, (_, s) => s).filter((s) => kinds.includes(hitAt(line, s)));
}

export interface Parts {
  family:  Family;
  idea:    string;
  clap:    string;
  fill:    string;
  hats:    { closed: string; open: string };
  bass:    string;
  perc:    [string, string];
  texture: number;
  /** The same parts, developed for later in the track. */
  later:   Later;
  /** Steps the idea may use, which the supporting percussion leaves empty. */
  room:    ReadonlySet<number>;
}

export interface Later {
  /** The idea with its first bar held and another answer: the middle's, then the end's. */
  answers: [string, string];
  clap:    string;
  hats:    { closed: string; open: string };
  bass:    string;
  perc:    [string, string];
}

export function familyOf(cfg: GeneratorConfig): Family {
  return familyById(cfg.family) ?? FAMILIES[Math.floor(hitNoise(cfg.seed, 0, 41) * FAMILIES.length)];
}

/** Each line, and the same line answering before it calls. */
function withTurns(lines: string[]): string[] {
  const all = lines.map(strip);
  for (const line of lines.map(strip)) {
    const half = line.length / 2;
    const turned = line.slice(half) + line.slice(0, half);
    if (!all.includes(turned)) all.push(turned);
  }
  return all;
}

type Choice = { idea: string; clap: string; fill: string; hats: string; bass: string; perc: [string, string] };

/** Everything wrong with a combination. An empty list is a take worth playing. */
export function weaknesses(family: Family, p: Choice, room: ReadonlySet<number>): string[] {
  const out: string[] = [];
  const idea = steps(p.idea);
  if (idea.length < 4) out.push("no clear idea");
  if (idea.length > 22) out.push("idea too busy");
  if (!steps(p.idea, "xhtu").some((s) => s % 4 !== 0)) out.push("idea hidden under the kick");

  const claps = steps(p.clap, "xo");
  if (claps.filter((s) => idea.includes(s)).length > 2) out.push("clap on top of the idea");
  const pitched = family.idea.lane === "stab" || family.idea.lane === "lead";
  const bass = family.idea.lane === "bass" ? [] : steps(p.bass);
  if (pitched && bass.filter((s) => idea.includes(s)).length > 3) out.push("bass on top of the idea");

  const support = p.perc.flatMap((line) => steps(line)).filter((s) => !room.has(s));
  const filled = new Set([...idea, ...claps, ...bass, ...support]).size;
  if (filled < 10) out.push("too empty");
  if (filled > 27) out.push("too busy");
  return out;
}

export function chooseParts(cfg: GeneratorConfig): Parts {
  const family = familyOf(cfg);
  const lane = family.idea.lane;
  const ideas = withTurns(family.idea.lines);
  // the gaps are where any of the family's ideas has a strong hit
  const room = new Set(family.idea.lines.map(strip).flatMap((line) => steps(line, "xhtu")));

  const drums: Pick<Choice, "clap" | "fill" | "hats">[] = [];
  for (const hats of family.hats) {
    for (const fill of family.fills) {
      for (const clap of new Set(family.claps.map(strip))) drums.push({ clap, fill, hats });
    }
  }
  const options = {
    idea: ideas.map((idea) => ({ idea })),
    drums,
    bass: lane === "bass" ? [] : withTurns(family.bass).map((bass) => ({ bass })),
    perc: lane === "perc" ? [] : family.perc.flatMap(([a, b]): { perc: [string, string] }[] => {
      const [p, q] = [strip(a), strip(b)];
      return [{ perc: [p, q] }, { perc: [q, p] }];
    }),
  };

  // deal combinations from the seed until one isn't weak
  const rng = makeRng(laneSeed({ ...cfg, laneSeeds: {} }, "hats") ^ 0x5bd1e995);
  const deal = <T,>(items: T[]): T | undefined => items[Math.floor(rng() * items.length)];
  let best: Choice | null = null;
  let faults = Infinity;
  for (let attempt = 0; attempt < 48 && faults > 0; attempt++) {
    const take: Choice = {
      idea: deal(options.idea)!.idea,
      ...deal(options.drums)!,
      bass: deal(options.bass)?.bass ?? "",
      perc: deal(options.perc)?.perc ?? ["", ""],
    };
    const found = weaknesses(family, take, room).length;
    if (found < faults) [best, faults] = [take, found];
  }
  const base = best!;

  // a rewrite steps on through the options that still work with the rest
  const rewrite = <T extends Partial<Choice>>(items: T[], of: Lane): Partial<Choice> => {
    const count = cfg.laneSeeds[of] ?? 0;
    if (!count || !items.length) return {};
    const keys = Object.keys(items[0]) as (keyof Choice)[];
    const same = (item: T) => keys.every((k) => String(item[k]) === String(base[k]));
    const changed = items.filter((item) => !same(item));
    const sound = changed.filter((item) => !weaknesses(family, { ...base, ...item }, room).length);
    // with nothing sound to move to, a change still beats a dead button
    const others = sound.length ? sound : changed;
    const turn = count % (others.length + 1);
    return turn ? others[turn - 1] : {};
  };
  const chosen: Choice = {
    ...base,
    ...rewrite(options.idea, lane),
    ...rewrite(options.drums, "drums"),
    ...rewrite(options.bass, "bass"),
    ...rewrite(options.perc, "perc"),
  };

  return {
    family,
    ...chosen,
    hats: hatLines(chosen.hats),
    texture: variantOf(cfg, "pad", 5),
    later: develop(cfg, family, base, chosen, options, room),
    room,
  };
}

const hatLines = (name: string) => ({ closed: strip(HATS[name].closed), open: strip(HATS[name].open) });

/**
 * What each part turns into later on. Each is judged against the take as dealt,
 * never against another lane's rewrite, so a rewrite still moves only its lane.
 */
function develop(
  cfg: GeneratorConfig, family: Family, base: Choice, chosen: Choice,
  options: { idea: { idea: string }[]; drums: Pick<Choice, "clap" | "fill" | "hats">[]; bass: { bass: string }[]; perc: { perc: [string, string] }[] },
  room: ReadonlySet<number>,
): Later {
  const pick = <T extends Partial<Choice>>(items: T[], salt: number): T | undefined => {
    const sound = items.filter((item) => !weaknesses(family, { ...base, ...item }, room).length);
    const from = sound.length ? sound : items;
    return from[Math.floor(hitNoise(cfg.seed, salt, 43) * from.length)];
  };

  const held = chosen.idea.slice(0, 16);
  const tail = chosen.idea.slice(16);
  const answered = [...new Set(options.idea.map((o) => o.idea.slice(16)))]
    .filter((other) => other !== tail)
    .map((other) => ({ idea: held + other }));
  const middle = pick(answered, 1)?.idea ?? chosen.idea;
  const end = pick(answered.filter((o) => o.idea !== middle), 2)?.idea ?? middle;

  const bothNew = options.drums.filter((d) => d.clap !== chosen.clap && d.hats !== chosen.hats);
  const drums = pick(bothNew.length ? bothNew : options.drums, 3)!;
  return {
    answers: [middle, end],
    clap: drums.clap,
    hats: hatLines(drums.hats),
    bass: pick(options.bass.filter((o) => o.bass !== chosen.bass), 4)?.bass ?? chosen.bass,
    perc: pick(options.perc.filter((o) => String(o.perc) !== String(chosen.perc)), 5)?.perc ?? chosen.perc,
  };
}
