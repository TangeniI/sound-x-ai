/**
 * lib/groove/families.ts
 *
 * The twelve Groove families. Each is written around one idea, and says what
 * carries it, what the clap or snare does, how the low end answers and how the
 * track winds down before a drop.
 *
 * The structure came from studying twelve records: one idea from the first bars,
 * gaps around it, and a job for the backbeat. The patterns are original.
 *
 * A pattern is a string of 16ths, spaces ignored, looped over its own length:
 *   x accent   o normal   - soft   h the answer (another note or voice)   . rest
 * In perc, t and u are the root and fifth toms. In claps, x is the main hit,
 * o the second clap and - a rim.
 */

import { CLAVI, FM, KITS, type Kit, type Layer } from "../audio/kits";
import type { FamilyId, Lane } from "../../types";

/** Four ways to lead up to the hit: a roll, opening tops, reversed air, or nothing at all. */
export type Tension = "roll" | "tops" | "air" | "gap";

export interface Family {
  id:      FamilyId;
  name:    string;
  about:   string;
  tempo:   [number, number];
  keys:    number[];      // roots whose sub sits from E1 to B1
  idea: {
    lane:   Lane;
    lines:  string[];
    length: number;       // in steps
    alt:    number;       // semitones to the answering note: root, fifth or octave
    lo:     number;       // bottom of the octave it sits in
    chord?: number[];     // a stab's semitones
  };
  claps:   string[];
  fills:   string[];      // one beat, for the end of a phrase
  hats:    string[];      // keys of HATS
  bass:    string[];
  perc:    [string, string][]; // two loops that may turn against the bar
  shaker:  boolean;
  ride:    boolean;
  pickup?: number;        // a ghost kick on this step of every second bar
  clapAt:  number;        // bar the clap arrives
  topsAt:  number;        // bar the open hats arrive
  pull:    "cut" | "thin"; // whether the low end leaves or thins before a hit
  turn:    1 | 2;         // beats pulled out before the eight-bar loop comes round
  tension: Tension;
  mix:     { pump: number; space: number; echo: number; rumble: number };
  kit:     Kit;
  /** Other tops and claps for the same family, so takes don't share every sound. */
  alts:    Partial<Kit>[];
}

export const HATS: Record<string, { closed: string; open: string }> = {
  offbeat: { closed: "-... -... -... -...", open: "..x. ..x. ..x. ..x." },
  driven:  { closed: "o-.- o-.- o-.- o-.-", open: "..x. ..x. ..x. ..x." },
  skipped: { closed: "-.xo -.x. -.xo -ox.", open: ".... ..x. .... ..x." },
  ticking: { closed: "x-o- o-x- x-o- o-x-", open: "..x. .... ..x. ...." },
  leaning: { closed: "..oo .-.o ..oo .-.o", open: "..x. ..x. ..x. ..o." },
  dry:     { closed: ".-x- .-x- .-x- .-xo", open: ".... .... .... ..x." },
  broken:  { closed: "o.x. -ox. o.x- .ox-", open: ".... ..x. ..o. ...." },
  running: { closed: "-ox- -oxo -ox- -oxo", open: "..x. .... ..x. ...." },
};

/* ─────────────────────── claps and snares ─────────────────────────── */

// Most are built as a producer would layer one: a short body, the crack, and some
// noise on top. The last four start from a recorded snare.
const SNARE = {
  crack: [
    { id: "rim_909", gain: 0.75, rate: 0.86, len: 0.09 },
    { id: "clap_909", gain: 0.8, delay: 0.004, hp: 650 },
    { id: "hat_raw", gain: 0.16, rate: 0.62, len: 0.06 },
  ],
  slam: [
    { id: "impact", gain: 0.55, rate: 1.7, len: 0.07, hp: 380 },
    { id: "rim_909", gain: 0.6, rate: 0.76, len: 0.1 },
    { id: "clap_808", gain: 0.85, rate: 0.93, delay: 0.005 },
  ],
  tight: [
    { id: "rim_909", gain: 0.8, rate: 1.12, len: 0.07 },
    { id: "perc_tap", gain: 0.35, rate: 0.74 },
    { id: "clap_hands", gain: 0.4, len: 0.08, delay: 0.003, hp: 900 },
  ],
  body: [
    { id: "tom_808", gain: 0.3, rate: 1.06, len: 0.05 },
    { id: "clap_909", gain: 0.8, rate: 0.95, delay: 0.002 },
    { id: "hat_raw", gain: 0.12, rate: 0.5, len: 0.09 },
  ],
  hands: [
    { id: "clap_hands", gain: 0.85 },
    { id: "clap_808", gain: 0.4, rate: 1.08, delay: 0.011 },
    { id: "rim_909", gain: 0.3, rate: 0.9, len: 0.06 },
  ],
  snap: [
    { id: "snare_909", gain: 0.85 },
    { id: "clap_909", gain: 0.35, delay: 0.004, hp: 900 },
  ],
  pinched: [
    { id: "snare_909_b", gain: 0.9, rate: 1.04 },
    { id: "rim_909", gain: 0.3, len: 0.05 },
  ],
  eight: [
    { id: "snare_808", gain: 0.9 },
    { id: "rim_808", gain: 0.25, len: 0.05 },
  ],
  room: [
    { id: "snare_real", gain: 0.8, len: 0.35 },
    { id: "clap_hands", gain: 0.3, delay: 0.006, hp: 1000 },
  ],
} satisfies Record<string, Layer[]>;

// the tops sit where they did in the twelve records, a few dB under the old kit's
const kit = (over: Partial<Kit>): Kit => ({ ...KITS.driving, tops: 0.62, ...over });
const [E, F, FS, G, GS, A, AS, B] = [4, 5, 6, 7, 8, 9, 10, 11];

/* ─────────────────────────── the families ─────────────────────────── */

export const FAMILIES: Family[] = [
  {
    id: "backbone", name: "Backbone", about: "A heavy backbeat, answered late by a low stab",
    tempo: [136, 139], keys: [F, FS, G],
    idea: {
      lane: "stab", length: 1.3, alt: 7, lo: 48, chord: [0, 12],
      lines: [
        "...x ..o. .... .o.. ...x ..o. ...o .x.h",
        ".... ..x. ...o .... .... ..x. ...o .-x.",
        "..x. .... .o.. ..-. ..x. .... .o.o .xh.",
      ],
    },
    claps: [".... x... .... x...", ".... x... .... x.-.", ".... x... .... x... .... x... .-.. x..o"],
    fills: ["x.oo", "x-ox", "xo.x"],
    hats: ["offbeat", "driven", "dry"],
    bass: ["..o. ...o ..o. ..xo", "...o ..x. ...o ..o."],
    perc: [["..x...", "......o..."], [".x.....", "....o......."]],
    shaker: false, ride: true, clapAt: 0, topsAt: 8,
    pull: "cut", turn: 2, tension: "roll",
    mix: { pump: 0.7, space: 0.3, echo: 0.3, rumble: 0.65 },
    kit: kit({
      kick: "kick_909", kickLen: 0.24, snare: SNARE.slam, snareGain: 1.3, slam: 0.2,
      perc: ["perc_tap", "rim_808"], percTone: 4200, stab: { open: 1500, rest: 360 },
      trim: { stab: 1.67, perc: 0.6 },
    }),
    alts: [{}, { snare: SNARE.snap, hatC: ["hat_raw", "hat_808_c"] }],
  },
  {
    id: "floor", name: "Rolling Floor", about: "The low end is the hook, with one late clap",
    tempo: [141, 145], keys: [E, F, G],
    idea: {
      lane: "bass", length: 0.8, alt: 0, lo: 28,
      lines: [
        ".-x. .-xo ..x. .oxo .-x. .ox. ..xo .oxo",
        "..xo .-x. ..xo .-.o ..xo .-x. ..xo .-ox",
        ".ox. ..xo .ox. ..x- .ox. ..xo .-x. .xox",
      ],
    },
    claps: [".... .... .... x...", ".... .... .... x..o .... .... .-.. x...", ".... .... .... x... .... .... .... x.o."],
    fills: ["..ox", ".o.x", "-o-x"],
    hats: ["offbeat", "skipped", "leaning"],
    bass: [],
    perc: [["x.....", ".....o....."], ["...x...", ".o.........."]],
    shaker: true, ride: false, clapAt: 8, topsAt: 8,
    pull: "cut", turn: 1, tension: "tops",
    mix: { pump: 0.62, space: 0.22, echo: 0.22, rumble: 0.5 },
    kit: kit({
      kickLen: 0.17, snare: SNARE.crack, snareGain: 1.45,
      bass: { sub: 0.3, decay: 0.05, body: { id: "kick_tek", gain: 0.9, tone: 520, rate: 1.9 } },
      perc: ["perc_blip", "perc_tap"], percTone: 5000,
      trim: { bass: 0.68, perc: 0.6 },
    }),
    alts: [{}, { clap: ["clap_808", "clap_hands"], hatO: "hat_808_o" }],
  },
  {
    id: "steel", name: "Loose Steel", about: "A hook played on struck metal, claps between it",
    tempo: [144, 148], keys: [FS, G, GS],
    idea: {
      lane: "perc", length: 1, alt: 0, lo: 0,
      lines: [
        "..x. .o.. .... x.h. ..x. .o.. ...- ..hh",
        ".x.. ..o. .h.. .... .x.. ..o. .hx. .-..",
        "...x .... o.h. ..-. ...x .... o.h. .h.x",
      ],
    },
    claps: [".... x... .... .x..", "...o .... .x.. ....", ".... .x.. .... x..-"],
    fills: [".xox", "x.xx", "-.ox"],
    hats: ["dry", "broken", "ticking"],
    bass: ["..o. ..o. ..o. ..x.", "...o ..x. ...o ..x-"],
    perc: [],
    shaker: true, ride: true, clapAt: 8, topsAt: 12,
    pull: "cut", turn: 1, tension: "gap",
    mix: { pump: 0.82, space: 0.4, echo: 0.2, rumble: 0.8 },
    kit: kit({
      kick: "kick_tek", kickRoot: 40.3, kickGain: 0.7, kickLen: undefined, slam: 0.3,
      snare: SNARE.slam, perc: ["brake_drum", "anvil"], percTone: 6000, percLen: 0.16,
      bass: { sub: 0.4, decay: 0.06, body: { id: "impact", gain: 0.6, tone: 300, rate: 1.1 } },
      sends: { stab: [0.3, 0.2], lead: [0.2, 0.2], perc: [0.22, 0.1] },
      trim: { perc: 0.84 },
    }),
    alts: [{}, { perc: ["anvil", "brake_drum"], hatC: ["hat_raw", "hat_909_c"] }],
  },
  {
    id: "night", name: "Night Shift", about: "One dark fifth thrown into echo over a straight clap",
    tempo: [140, 144], keys: [F, G, A],
    idea: {
      lane: "stab", length: 2.4, alt: 12, lo: 48, chord: [0, 7],
      lines: [
        "...x .... .... .... .... ..o. .... .-.h",
        ".... ..x. .... .... .... ..x. .... ..-h",
        ".... .... .x.. .... ..o. .... .x.. ...-",
      ],
    },
    claps: [".... x... .... x...", ".... x... .... x... .... x... .... x.o.", ".... x... .... x..."],
    fills: ["x..o", "x.-o", "xo.."],
    hats: ["leaning", "offbeat", "skipped"],
    bass: [".-x. .-x. .-x. .ox.", "..x. .ox. ..x. .-xo"],
    perc: [["..o..", "........x..."], [".x....", ".......o..."]],
    shaker: true, ride: false, pickup: 15, clapAt: 8, topsAt: 8,
    pull: "thin", turn: 1, tension: "air",
    mix: { pump: 0.66, space: 0.5, echo: 0.8, rumble: 0.6 },
    kit: kit({
      kickLen: 0.2, snare: SNARE.body, snareGain: 1.4, stab: { open: 1700, rest: 420 },
      perc: ["rim_808", "perc_blip"], percTone: 4500,
      sends: { stab: [0.3, 0.6], lead: [0.2, 0.3], perc: [0.15, 0.2] },
      trim: { stab: 1.8, perc: 0.55 },
    }),
    alts: [{}, { snare: SNARE.room, hatC: ["hat_808_c", "hat_raw"], hatO: "hat_808_o" }],
  },
  {
    id: "hands", name: "Hand to Hand", about: "Hands and skins in call and answer",
    tempo: [139, 143], keys: [G, GS, A],
    idea: {
      lane: "perc", length: 1, alt: 0, lo: 0,
      lines: [
        ".xo. .-h. .t.. .xh. .xo. .-h. ..tu .x.h",
        "..x- .h.. ..xt .... ..x- .h.o ..u. .thh",
        ".t.x ..h. .... .xo. .t.x ..h. .uu. .xoh",
      ],
    },
    claps: [".... .... .... x...", ".... x... .... ...o", ".... ..o. .... x... .... .... .... x.oo"],
    fills: ["o.ox", ".oox", "oo-x"],
    hats: ["skipped", "offbeat", "dry"],
    bass: ["...o .... ...x ..o.", "..o. .... ..x. ...o"],
    perc: [],
    shaker: true, ride: false, pickup: 11, clapAt: 8, topsAt: 16,
    pull: "thin", turn: 1, tension: "roll",
    mix: { pump: 0.55, space: 0.32, echo: 0.24, rumble: 0.5 },
    kit: kit({
      kick: "kick_909", kickLen: 0.28, snare: SNARE.hands, snareGain: 1.4,
      perc: ["clap_hands", "perc_tap"], percTone: 3400, percLen: 0.14, hatC: ["hat_raw", "hat_808_c"],
      sends: { stab: [0.3, 0.2], lead: [0.2, 0.2], perc: [0.18, 0.12] },
      trim: { perc: 0.64 },
    }),
    alts: [{}, { perc: ["perc_tap", "rim_909"], snare: SNARE.pinched }],
  },
  {
    id: "wire", name: "Live Wire", about: "A squared 808 line that stays on one note",
    tempo: [137, 141], keys: [E, G, A],
    idea: {
      lane: "lead", length: 0.85, alt: 12, lo: 43,
      lines: [
        "x.o. .-h. ..o. x..- x.o. .-h. ..oo .xh.",
        ".xo. .... -x.h .... .xo. .... -x.h ..oh",
        "x..o ..x. .h.. o... x..o ..x. .h.. o.xh",
      ],
    },
    claps: [".... x... .... x...", ".... x... .... x..-", ".... x... .... x... .... x... .... xo.."],
    fills: ["x.xx", "xoox", "x-.x"],
    hats: ["driven", "ticking", "offbeat"],
    bass: ["..o. .... ..o. ...o", "...o .... ..o. ...."],
    perc: [["....o..", ".........x.."], ["..o.....", ".......x..."]],
    shaker: false, ride: true, clapAt: 8, topsAt: 8,
    pull: "cut", turn: 1, tension: "tops",
    mix: { pump: 0.6, space: 0.3, echo: 0.4, rumble: 0.45 },
    kit: kit({
      kick: "kick_909", kickLen: 0.22, snare: SNARE.crack,
      lead: { zones: FM, cutoff: 700, decay: 0.09, gain: 0.3, acid: { sweep: 2300, q: 7 } },
      perc: ["perc_tap", "rim_909"], percTone: 4000,
      bass: { sub: 0.3, decay: 0.05, body: { id: "perc_blip", gain: 0.6, tone: 240, rate: 0.8 } },
      trim: { lead: 0.98, perc: 0.5 },
    }),
    alts: [{}, { clap: ["clap_808", "clap_909"], snare: SNARE.eight }],
  },
  {
    id: "concrete", name: "Concrete", about: "A scrape chopped into the groove, with a huge snare",
    tempo: [136, 140], keys: [E, FS, GS],
    idea: {
      lane: "pad", length: 1.5, alt: 0, lo: 48,
      lines: [
        "x... ..o. .... .h.. x... ..o. .... .h.h",
        "..x. .... .o.. .... ..x. ..-. .o.h ....",
        ".x.. .... ..xo .... .x.. .... ..x. .ho.",
      ],
    },
    claps: [".... x... .... x...", ".... x... .... x... .... x... ...- x...", ".... .... .... x... .... x... .... x..o"],
    fills: ["x..x", "x.ox", "x-xx"],
    hats: ["dry", "offbeat", "broken"],
    bass: ["...o ..o. ...o ..x.", "..o. ...x ..o. ...."],
    perc: [["......x", "..........o."], ["...o.....", "......x...."]],
    shaker: false, ride: true, clapAt: 16, topsAt: 16,
    pull: "cut", turn: 2, tension: "gap",
    mix: { pump: 0.85, space: 0.45, echo: 0.26, rumble: 0.9 },
    kit: kit({
      kick: "kick_tek", kickRoot: 40.3, kickGain: 0.72, kickLen: undefined, slam: 0.3,
      snare: SNARE.slam, snareGain: 1.35,
      texture: { id: "gong_scrape", rate: 1.1, offset: 0.25, from: 300, to: 2600, gain: 0.38 },
      perc: ["rim_909", "brake_drum"], percTone: 3000, percLen: 0.14,
      trim: { pad: 3, perc: 0.5 },
    }),
    alts: [{}, { texture: { id: "gong_scrape", rate: 0.85, offset: 1.4, from: 250, to: 2100, gain: 0.76 }, snare: SNARE.crack }],
  },
  {
    id: "signal", name: "Signal", about: "One coded note repeating, answered an octave up",
    tempo: [144, 148], keys: [A, AS, B],
    idea: {
      lane: "lead", length: 0.6, alt: 12, lo: 52,
      lines: [
        "x..x .... .o.. .... x..x .... .o.h ..h.",
        "..x. x... .... .o.. ..x. x... .... .oh.",
        ".x.o .... x... .... .x.o .... x..h ....",
      ],
    },
    claps: [".... .... .... x...", ".... x... .... x...", ".... ...o .... x... .... .... .... x.-."],
    fills: ["-.ox", ".xxo", "o..x"],
    hats: ["running", "driven", "leaning"],
    bass: [".-x. .-x. .-x. .-x.", "..xo ..x. ..xo ..x.", "...o ..x. ...o .-x.", ".... ..o. .... ..x."],
    perc: [["x......", ".....o....."], ["..o..", "........x..."]],
    shaker: false, ride: true, clapAt: 8, topsAt: 8,
    pull: "thin", turn: 1, tension: "air",
    mix: { pump: 0.65, space: 0.4, echo: 0.55, rumble: 0.55 },
    kit: kit({
      kickLen: 0.16, snare: SNARE.tight, snareGain: 1.3, hatC: ["hat_808_c", "hat_909_c"],
      lead: { zones: FM, cutoff: 1000, decay: 0.04, gain: 0.3 },
      perc: ["perc_blip", "rim_808"], percTone: 6000,
      trim: { lead: 1.5, perc: 0.5 },
    }),
    alts: [{}, { hatO: "hat_808_o", snare: SNARE.crack }],
  },
  {
    id: "undertow", name: "Undertow", about: "Tuned toms roll underneath and answer at the bar line",
    tempo: [138, 142], keys: [F, G, AS],
    idea: {
      lane: "perc", length: 1, alt: 0, lo: 0,
      lines: [
        ".-t. .t-. .-t. .tu. .-t. .t-. .-tu .ttu",
        "..t- .... ..tu .t.. ..t- .... ..tu .tt.",
        ".t.t ..-. .u.. ..t. .t.t ..-. .u.t .ut.",
      ],
    },
    claps: ["...x .... .... ....", ".... .... ..x. ....", ".... .... .... .... .... x... .... ...o"],
    fills: ["o-.x", "..xo", "-o.x"],
    hats: ["broken", "ticking", "dry"],
    bass: ["...o .... .... ..o.", ".... ..o. .... ...o"],
    perc: [],
    shaker: false, ride: false, clapAt: 16, topsAt: 8,
    pull: "thin", turn: 1, tension: "tops",
    mix: { pump: 0.6, space: 0.35, echo: 0.2, rumble: 0.7 },
    kit: kit({
      kick: "kick_909", kickLen: 0.3, snare: SNARE.body, snareGain: 1.4,
      perc: ["rim_909", "perc_tap"], percTone: 2800,
      sends: { stab: [0.3, 0.2], lead: [0.2, 0.2], perc: [0.2, 0.08] },
      trim: { perc: 0.48 },
    }),
    alts: [{}, { snare: SNARE.hands, hatO: "hat_808_o" }],
  },
  {
    id: "exhaust", name: "Exhaust", about: "Bursts of machine air against a syncopated clap",
    tempo: [145, 149], keys: [FS, A, B],
    idea: {
      lane: "pad", length: 0.9, alt: 0, lo: 48,
      lines: [
        "..xx ..o. .... h... ..xx ..o. .... h.h.",
        ".x.. x... .oo. .... .x.. x... .oo. ..hh",
        "x.x. .... .h.. .o.. x.x. .... .h.. .oxh",
      ],
    },
    claps: [".... .x.. .... x...", ".... x... ...o ....", "...x .... .... x... .... .x.. .... x..o"],
    fills: ["xx.x", "o.xx", ".x-x"],
    hats: ["running", "broken", "driven"],
    bass: ["..x. ..x. ..x. ..xo", ".-x. ..x. .-x. ..x."],
    perc: [["....x", "........o.."], [".x.....", "......o....."]],
    shaker: false, ride: true, clapAt: 0, topsAt: 12,
    pull: "cut", turn: 1, tension: "roll",
    mix: { pump: 0.8, space: 0.36, echo: 0.3, rumble: 0.7 },
    kit: kit({
      kickLen: 0.15, slam: 0.22, snare: SNARE.crack,
      texture: { id: "fx_bed", rate: 1.6, offset: 0.6, from: 500, to: 3800, gain: 0.9 },
      perc: ["rim_808", "perc_tap"], percTone: 5500,
      trim: { pad: 1.65, perc: 0.5 },
    }),
    alts: [{}, { texture: { id: "fx_bed", rate: 1.15, offset: 2, from: 420, to: 3000, gain: 0.9 }, snare: SNARE.slam }],
  },
  {
    id: "clockwork", name: "Clockwork", about: "Rims and clicks interlock, the clap cuts across",
    tempo: [142, 146], keys: [E, GS, AS],
    idea: {
      lane: "perc", length: 1, alt: 0, lo: 0,
      lines: [
        "x..h ..x. .h.. x..h ..x. .h.. x..h ..xh",
        ".x.. h.x. ..h. .x.. .x.. h.x. ..h. .xhh",
        "..xh ..x. h..x ..h. ..xh ..x. h..x .xh.",
      ],
    },
    claps: [".... .... .x.. ....", ".... x... .... ..o.", ".... .... .... x... ..o. .... .x.. ...."],
    fills: ["-oox", ".-xx", "o-.x"],
    hats: ["dry", "skipped", "ticking"],
    bass: ["..x. .... ..x. ..o.", ".... ..x. ...o ..x."],
    perc: [],
    shaker: false, ride: false, pickup: 7, clapAt: 8, topsAt: 8,
    pull: "thin", turn: 1, tension: "gap",
    mix: { pump: 0.6, space: 0.28, echo: 0.45, rumble: 0.55 },
    kit: kit({
      kickLen: 0.18, snare: SNARE.tight, snareGain: 1.15,
      perc: ["rim_808", "rim_909"], percTone: 6500, percLen: 0.1,
      sends: { stab: [0.2, 0.2], lead: [0.2, 0.2], perc: [0.1, 0.22] },
      trim: { perc: 0.88 },
    }),
    alts: [{}, { perc: ["perc_blip", "rim_808"], trim: { perc: 1.25 }, hatC: ["hat_808_c", "hat_raw"] }],
  },
  {
    id: "splinter", name: "Splinter", about: "A choked, struck-key figure with a hard answering clap",
    tempo: [141, 145], keys: [G, A, B],
    idea: {
      lane: "lead", length: 0.7, alt: 7, lo: 64,
      lines: [
        ".x.. ..o. x... ...h .x.. ..o. x... .h.h",
        "..o. .x.. ..o. h... ..o. .x.. ..oh ....",
        "x... .o.. ..h. .... x... .o.. ..h. x.h.",
      ],
    },
    claps: [".... x... .... x...", ".... .... .... x..o", ".... x... .... .... .... x... .... .xo."],
    fills: ["xo.x", ".oxx", "x-o-"],
    hats: ["leaning", "broken", "offbeat"],
    bass: [".ox. ..x. .ox. ..x-", "...o ..xo ...o ..x."],
    perc: [["...o....", ".........x."], ["o.....", ".......x...."]],
    shaker: false, ride: true, clapAt: 8, topsAt: 12,
    pull: "cut", turn: 2, tension: "air",
    mix: { pump: 0.68, space: 0.42, echo: 0.5, rumble: 0.6 },
    kit: kit({
      kick: "kick_909", kickLen: 0.2, snare: SNARE.hands, snareGain: 1.15,
      lead: { zones: CLAVI, cutoff: 900, decay: 0.05, gain: 0.3 },
      perc: ["perc_tap", "perc_blip"], percTone: 3600,
      trim: { lead: 1.3, perc: 0.5 },
    }),
    alts: [{}, { snare: SNARE.snap, hatO: "hat_808_o" }],
  },
];

export const FAMILY_IDS: FamilyId[] = FAMILIES.map((f) => f.id);

export function familyById(id: unknown): Family | undefined {
  return FAMILIES.find((f) => f.id === id);
}
