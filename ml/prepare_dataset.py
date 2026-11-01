"""
prepare_dataset.py - build the riff corpus from real MIDI files.

Reads the Lakh MIDI "clean" dataset (Raffel, 2016), keeps electronic and dance
artists, and turns their synth and bass parts into two-bar riffs on a 16th-note
grid. Riffs are stored as scale degrees relative to the detected key, the same
representation the app plays back.

Artists are split into train / validation / test, so nothing a model is scored
on comes from an artist it trained on. Splitting by file or by riff would leak
near-identical repeats of the same song into the test set.

The MIDI files are not redistributed. Download the dataset yourself, then run:

    python3 ml/prepare_dataset.py <path-to-clean_midi>

Writes ml/data/riffs.npz (git-ignored) and ml/data_stats.json.
"""

import hashlib
import json
import os
import random
import struct
import sys

import numpy as np

STEPS = 32           # two bars of 16ths
DEG_LO, DEG_HI = -7, 14
REST = DEG_HI + 1    # internal marker before tokenising

ARTISTS = [
    "2 Unlimited", "808 State", "ATB", "Ace of Base", "Alice Deejay", "Aphex Twin", "Apollo 440",
    "Art of Noise", "Basement Jaxx", "Basshunter", "Black Box", "Bomfunk MC's", "C+C Music Factory",
    "Chicane", "Corona", "Culture Beat", "DJ BoBo", "DJ Paul Elstak", "DJ Quicksilver", "Daft Punk",
    "Darude", "Depeche Mode", "Eiffel 65", "Energy 52", "Erasure", "Faithless", "Fatboy Slim",
    "Frankie Goes to Hollywood", "Gigi D'Agostino", "Giorgio Moroder", "Haddaway", "Harold Faltermeyer",
    "Inner City", "Jam & Spoon", "Jean Michel Jarre", "Kraftwerk", "La Bouche", "Lipps Inc.", "M",
    "M/A/R/R/S", "Madison Avenue", "Massive Attack", "Moby", "Mr. President", "N-Trance", "New Order",
    "Nine Inch Nails", "OMD", "Orbital", "Orchestral Manoeuvres in the Dark", "Paul van Dyk",
    "Pet Shop Boys", "Real McCoy", "Robert Miles", "Rozalla", "S'Express", "SASH!", "Scooter", "Snap",
    "Soft Cell", "Sparks", "Stardust", "Tangerine Dream", "Technotronic", "The Beloved", "The Chemical Brothers",
    "The Human League", "The Prodigy", "The Shamen", "Tiësto", "Ultravox", "Underworld", "Vangelis",
    "Vengaboys", "Yaz", "Yazoo", "Yello",
]

# General MIDI families that carry riffs in this music
RIFF_PROGRAMS = set(range(32, 40)) | set(range(80, 88)) | set(range(98, 104)) | {4, 5, 6, 16, 17, 18}
RIFF_WORDS = ("bass", "lead", "synth", "arp", "riff", "seq", "acid", "melody", "stab")

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]


# ─────────────────────────────────────────────────────────────────────────────
# Minimal Standard MIDI File reader
# ─────────────────────────────────────────────────────────────────────────────
def read_var(data, i):
    value = 0
    while True:
        b = data[i]
        i += 1
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            return value, i


def parse_track(data):
    """Return (notes, programs, name, time_signatures) for one MTrk chunk."""
    i, tick, status = 0, 0, 0
    open_notes, notes, programs, timesigs = {}, [], {}, []
    name = ""
    n = len(data)
    while i < n:
        delta, i = read_var(data, i)
        tick += delta
        b = data[i]
        if b & 0x80:
            status = b
            i += 1
        kind = status & 0xF0
        chan = status & 0x0F
        if status == 0xFF:
            meta = data[i]
            length, i = read_var(data, i + 1)
            body = data[i:i + length]
            i += length
            if meta == 0x03:
                name = body.decode("latin-1", "ignore").lower()
            elif meta == 0x58 and length >= 2:
                timesigs.append((tick, body[0], 2 ** body[1]))
        elif status in (0xF0, 0xF7):
            length, i = read_var(data, i)
            i += length
        elif kind in (0x80, 0x90):
            pitch, vel = data[i], data[i + 1]
            i += 2
            key = (chan, pitch)
            if kind == 0x90 and vel > 0:
                open_notes[key] = (tick, vel)
            elif key in open_notes:
                start, v = open_notes.pop(key)
                notes.append((start, tick, pitch, v, chan))
        elif kind in (0xA0, 0xB0, 0xE0):
            i += 2
        elif kind == 0xC0:
            programs.setdefault(chan, data[i])
            i += 1
        elif kind == 0xD0:
            i += 1
        else:
            raise ValueError("bad status byte")
    return notes, programs, name, timesigs


def parse_midi(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    header_len = struct.unpack(">I", raw[4:8])[0]
    _, n_tracks, division = struct.unpack(">HHH", raw[8:14])
    if division & 0x8000:
        raise ValueError("SMPTE timing")
    tracks, timesigs = [], []
    i = 8 + header_len
    for _ in range(n_tracks):
        if raw[i:i + 4] != b"MTrk":
            break
        length = struct.unpack(">I", raw[i + 4:i + 8])[0]
        notes, programs, name, ts = parse_track(raw[i + 8:i + 8 + length])
        tracks.append((notes, programs, name))
        timesigs += ts
        i += 8 + length
    return division, tracks, timesigs


# ─────────────────────────────────────────────────────────────────────────────
# Music extraction
# ─────────────────────────────────────────────────────────────────────────────
def estimate_key(tracks):
    weights = np.zeros(12)
    for notes, _, _ in tracks:
        for start, end, pitch, _, chan in notes:
            if chan != 9:
                weights[pitch % 12] += max(1, end - start)
    if weights.sum() == 0:
        return None
    best, key = -2.0, None
    for root in range(12):
        rotated = np.roll(weights, -root)
        for mode, profile in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
            r = np.corrcoef(rotated, profile)[0, 1]
            if r > best:
                best, key = r, (root, mode)
    return key


def to_degree(pitch, root, scale):
    """Map a MIDI pitch to the nearest scale degree above middle C's octave."""
    rel = pitch - (60 + root)
    octave = rel // 12
    pc = rel % 12
    idx = min(range(7), key=lambda k: min(abs(scale[k] - pc), 12 - abs(scale[k] - pc)))
    if pc > 9 and scale[idx] < 3:
        octave += 1  # e.g. a major 7th rounding up to the next root
    return octave * 7 + idx


def track_is_riff(notes, programs, name):
    if not notes or notes[0][4] == 9:
        return False
    return (set(programs.values()) & RIFF_PROGRAMS) or any(w in name for w in RIFF_WORDS)


def quantise(notes, ppq):
    """Snap onsets to 16ths. One note per step: highest, or lowest for bass parts."""
    step_ticks = ppq / 4
    low_part = np.median([n[2] for n in notes]) < 48
    grid, off = {}, 0
    for start, _, pitch, _, _ in notes:
        pos = start / step_ticks
        s = int(round(pos))
        off += abs(pos - s) > 0.25
        current = grid.get(s)
        if current is None or (pitch < current if low_part else pitch > current):
            grid[s] = pitch
    return grid, off / len(notes)


def riffs_from_track(notes, ppq, key):
    root, mode = key
    scale = MINOR_SCALE if mode == "minor" else MAJOR_SCALE
    grid, off_grid = quantise(notes, ppq)
    if off_grid > 0.15:   # triplet or free-time playing does not sit on this grid
        return []
    last = max(grid)
    out = []
    for start in range(0, last, 16):   # hop one bar, keep two
        steps = [grid.get(start + i) for i in range(STEPS)]
        played = [p for p in steps if p is not None]
        if not 4 <= len(played) <= 28:
            continue
        degrees = [None if p is None else to_degree(p, root, scale) for p in steps]
        sounded = [d for d in degrees if d is not None]
        if len(set(sounded)) < 2:
            continue
        # fold the phrase to the register the app plays in
        shift = 7 * round(float(np.median(sounded)) / 7 - 0.25)
        out.append([REST if d is None else int(np.clip(d - shift, DEG_LO, DEG_HI)) for d in degrees])
    return out


def process_file(path):
    ppq, tracks, timesigs = parse_midi(path)
    if any(n != 4 or d != 4 for _, n, d in timesigs):
        return []
    key = estimate_key(tracks)
    if key is None:
        return []
    riffs = []
    for notes, programs, name in tracks:
        if track_is_riff(notes, programs, name):
            riffs += riffs_from_track(notes, ppq, key)
    return riffs


def main():
    root = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    by_artist = {}
    files = failed = 0
    for artist in ARTISTS:
        folder = os.path.join(root, artist)
        if not os.path.isdir(folder):
            continue
        seen = set()
        riffs = []
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith((".mid", ".midi")):
                continue
            files += 1
            try:
                found = process_file(os.path.join(folder, name))
            except (ValueError, IndexError, struct.error):
                failed += 1
                continue
            for r in found:
                h = hashlib.sha1(bytes(x + 20 for x in r)).digest()
                if h not in seen:
                    seen.add(h)
                    riffs.append(r)
        if riffs:
            by_artist[artist] = riffs

    # greedy split by artist so each side gets a fair share of the riffs
    artists = sorted(by_artist)
    random.Random(7).shuffle(artists)
    total = sum(len(v) for v in by_artist.values())
    targets = {"val": total * 0.15, "test": total * 0.15}
    split = {"train": [], "val": [], "test": []}
    counts = {"val": 0, "test": 0}
    for a in artists:
        placed = False
        for side in ("val", "test"):
            if counts[side] + len(by_artist[a]) <= targets[side] * 1.15 and counts[side] < targets[side]:
                split[side].append(a)
                counts[side] += len(by_artist[a])
                placed = True
                break
        if not placed:
            split["train"].append(a)

    degrees = sorted({d for riffs in by_artist.values() for r in riffs for d in r if d != REST})
    vocab = ["REST"] + degrees + ["BOS"]
    index = {d: i + 1 for i, d in enumerate(degrees)}
    index[REST] = 0

    os.makedirs(os.path.join(here, "data"), exist_ok=True)
    arrays = {}
    for side, names in split.items():
        rows = [[index[d] for d in r] for a in names for r in by_artist[a]]
        arrays[side] = np.array(rows, dtype=np.int16)
    np.savez_compressed(os.path.join(here, "data", "riffs.npz"), vocab=np.array(vocab, dtype=object), **arrays)

    stats = {
        "source": "Lakh MIDI Dataset, clean_midi subset (Raffel, 2016)",
        "filesRead": files,
        "filesFailed": failed,
        "artistsUsed": len(by_artist),
        "riffs": {k: int(len(v)) for k, v in arrays.items()},
        "artists": {k: sorted(v) for k, v in split.items()},
        "steps": STEPS,
        "vocab": [str(v) for v in vocab],
    }
    with open(os.path.join(here, "data_stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print(json.dumps({k: stats[k] for k in ("filesRead", "filesFailed", "artistsUsed", "riffs")}))


if __name__ == "__main__":
    main()
