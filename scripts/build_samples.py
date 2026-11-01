#!/usr/bin/env python3
"""
build_samples.py - turn the raw CC0 / CC BY recordings into the app's sample pack.

Every sound in public/samples/ comes from a real recording; nothing is
synthesised. See public/samples/SOURCES.md for where each one came from.

    python3 scripts/build_samples.py <raw-dir>

Raw layout: <raw-dir>/{sonicpi,tr8,fischer808,vcsl,tx81z,ir}. Needs ffmpeg
and numpy. Each sample is trimmed to its audible length, faded, peak-normalised
and written as 16-bit 44.1 kHz FLAC.
"""

import os
import subprocess
import sys

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "samples")

# id, source, options. mono=True folds to mono (the low end must stay mono).
#   max: longest allowed length (s)   hp: high-pass (Hz)   floor: tail cut (dB)
SAMPLES = [
    # kicks
    ("kick_909", "tr8/006_909_Bass_Drum_3.wav", dict(mono=True, max=0.6)),
    ("kick_909_atk", "tr8/012_909_AttackBD_1.wav", dict(mono=True, max=0.5)),
    ("kick_tek", "sonicpi/bd_tek.flac", dict(mono=True)),
    ("kick_klub", "sonicpi/bd_klub.flac", dict(mono=True)),
    ("kick_808_long", "fischer808/bd8_BD0010.WAV", dict(mono=True, max=2.6)),
    # claps + rims
    ("clap_909", "tr8/019_909_Hand_Clap.wav", dict(mono=True, max=0.35)),
    ("clap_808", "fischer808/cp8_CP.WAV", dict(mono=True, max=0.45)),
    ("clap_hands", "vcsl/Clap_rr2.wav", dict(mono=True, max=0.4)),
    ("rim_909", "tr8/009_909_Rim_Shot.wav", dict(mono=True, max=0.15)),
    ("rim_808", "fischer808/rs8_RS.WAV", dict(mono=True)),
    # hats + cymbals
    ("hat_909_c", "tr8/008_909_Closed_HiHat.wav", dict(mono=True, max=0.3)),
    ("hat_909_o", "tr8/007_909_Open_HiHat.wav", dict(mono=True, max=0.7)),
    ("hat_808_c", "fischer808/ch8_CH.WAV", dict(mono=True)),
    ("hat_808_o", "fischer808/oh8_OH50.WAV", dict(mono=True)),
    ("hat_raw", "sonicpi/hat_raw.flac", dict(mono=True)),
    ("ride_909", "tr8/026_909_Ride_Cymbal.wav", dict(mono=True, max=1.4)),
    ("crash_909", "tr8/020_909_Crash_Cymbal.wav", dict(mono=True, max=1.6)),
    ("cymbal_808_long", "fischer808/cy8_CY0010.WAV", dict(mono=True, max=3.6)),
    ("shaker", "vcsl/Mid_ShakerHighFaster_Down_rr1.wav", dict(mono=True, hp=500)),
    # metal + percussion
    ("anvil", "vcsl/Anvil_Hit2_v3_rr1_Mid.wav", dict(mono=True, max=0.7)),
    ("brake_drum", "vcsl/BrakeDrum1_Hammer_v3_rr1_Mid.wav", dict(mono=True, max=0.6)),
    ("cowbell_808", "fischer808/cb8_CB.WAV", dict(mono=True, max=0.5)),
    ("tom_808", "fischer808/lc8_LC50.WAV", dict(mono=True)),
    ("perc_tap", "sonicpi/tbd_perc_tap_2.flac", dict(mono=True)),
    ("perc_blip", "sonicpi/tbd_perc_blip.flac", dict(mono=True)),
    # bass (all rooted on C2)
    ("bass_hard", "sonicpi/bass_hard_c.flac", dict(mono=True, max=1.5)),
    ("bass_thick", "sonicpi/bass_thick_c.flac", dict(mono=True, max=2.0)),
    ("bass_trance", "sonicpi/bass_trance_c.flac", dict(mono=True, max=2.0)),
    # sampled chords and pads, played in parallel like an old hardware sampler
    ("chord_em9", "sonicpi/guit_em9.flac", dict(max=3.5)),
    ("chord_high", "sonicpi/tbd_highkey_c4.flac", dict()),
    ("pad_1", "sonicpi/tbd_pad_1.flac", dict()),
    ("pad_2", "sonicpi/tbd_pad_2.flac", dict()),
    ("pad_3", "sonicpi/tbd_pad_3.flac", dict()),
    # Yamaha TX81Z hardware
    ("fm_c3", "tx81z/FMPiano_C3_vl3.wav", dict(mono=True, max=2.5)),
    ("fm_c4", "tx81z/FMPiano_C4_vl3.wav", dict(mono=True, max=2.2)),
    ("fm_c5", "tx81z/FMPiano_C5_vl3.wav", dict(mono=True, max=1.8)),
    ("clavi_c5", "tx81z/Clavisynth_C3_vl3.wav", dict(mono=True, max=1.6)),
    ("clavi_c6", "tx81z/Clavisynth_C4_vl3.wav", dict(mono=True, max=1.0)),
    # impacts, risers and texture
    ("gong", "vcsl/gong_fff.wav", dict(max=5.0)),
    ("gong_scrape", "vcsl/gong_scrape_mf.wav", dict(max=7.0)),
    ("impact", "sonicpi/perc_impact1.flac", dict()),
    ("boom", "sonicpi/misc_cineboom.flac", dict(max=4.0)),
    ("vinyl", "sonicpi/vinyl_hiss.flac", dict(hp=120, floor=-90, norm=False)),
    ("drone", "sonicpi/loop_drone_g_97.flac", dict(floor=-90)),
    ("fx_bed", "sonicpi/tbd_fxbed_loop.flac", dict(floor=-90)),
]

# Real rooms, used by the convolution reverbs. A B-format capture decodes to L/R
# from its measured sound field; two mono receiver positions become L and R.
IMPULSES = [
    ("ir_hall", "ir/divinity/Divinity_BForm_S1_R1_a.wav", 4.4),
    ("ir_room", ["ir/guildhall/councilchamber_s1_r1_ir_1_48000.wav",
                 "ir/guildhall/councilchamber_s1_r4_ir_1_48000.wav"], 1.3),
]


def load(path, mono):
    args = ["ffmpeg", "-v", "error", "-i", path, "-ar", str(SR), "-ac", "2", "-f", "f32le", "-"]
    raw = subprocess.run(args, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()
    return x.mean(axis=1, keepdims=True) if mono else x


def high_pass(x, hz):
    from scipy.signal import butter, sosfiltfilt
    return sosfiltfilt(butter(4, hz, "highpass", fs=SR, output="sos"), x, axis=0).astype(np.float32)


def tail_end(x, floor_db):
    win = int(SR * 0.01)
    power = (x ** 2).mean(axis=1)
    env = np.sqrt(np.convolve(power, np.ones(win) / win, "same"))
    above = np.where(env > env.max() * 10 ** (floor_db / 20))[0]
    return int(above[-1]) if len(above) else len(x)


def write(x, name):
    path = os.path.join(OUT, name + ".flac")
    args = ["ffmpeg", "-y", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", str(x.shape[1]),
            "-i", "-", "-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "8", path]
    subprocess.run(args, input=x.astype(np.float32).tobytes(), check=True)
    return os.path.getsize(path)


def build_sample(raw, sid, src, opt):
    x = load(os.path.join(raw, src), opt.get("mono", False))
    if "hp" in opt:
        x = high_pass(x, opt["hp"])
    onset = int(np.argmax(np.abs(x).max(axis=1) > np.abs(x).max() * 0.02))
    x = x[max(0, onset - 16):]
    end = min(tail_end(x, opt.get("floor", -55)), int(opt.get("max", 1e6) * SR), len(x))
    x = x[:end]
    fade = min(int(SR * 0.03), len(x) // 4)
    x[-fade:] *= np.linspace(1, 0, fade)[:, None]
    if opt.get("norm", True):
        x = x / (np.abs(x).max() + 1e-9) * 0.95
    return write(x, sid)


def load_bformat(path):
    args = ["ffmpeg", "-v", "error", "-i", path, "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(args, capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 4)
    w, side = x[:, 0], x[:, 1]  # ACN order: W, then the left-right figure-of-eight
    return [(w + 0.7 * side)[:, None], (w - 0.7 * side)[:, None]]


def build_impulse(raw, sid, sources, seconds):
    if isinstance(sources, str):
        chans = load_bformat(os.path.join(raw, sources))
    else:
        chans = [load(os.path.join(raw, s), True) for s in sources]
    out = []
    start = min(int(np.argmax(np.abs(c))) for c in chans)
    for c in chans:
        c = c[start:][:, 0].copy()
        c = c[:int(seconds * SR)]
        tail = int(len(c) * 0.3)
        c[-tail:] *= np.cos(np.linspace(0, np.pi / 2, tail)) ** 2
        out.append(c)
    n = min(len(c) for c in out)
    x = np.stack([c[:n] for c in out], axis=1)
    return write(x / (np.abs(x).max() + 1e-9) * 0.95, sid)


def main():
    raw = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for sid, src, opt in SAMPLES:
        total += build_sample(raw, sid, src, opt)
    for sid, sources, seconds in IMPULSES:
        total += build_impulse(raw, sid, sources, seconds)
    print(f"{len(SAMPLES) + len(IMPULSES)} files, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
