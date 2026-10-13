#!/usr/bin/env python3
"""Reproduce the theme packs' original UI cues and instrumental loops.

Python standard library only. No samples, existing melodies, or vocal models are
used. Files are mono 44.1 kHz PCM16 WAV, with conservative peaks and zero-crossing
envelopes. Notes in instrumental loops wrap their tails across the loop boundary.
"""

from array import array
from pathlib import Path
import argparse
import math
import struct
import wave


RATE = 44_100
ROOT = Path(__file__).resolve().parents[1] / "examples" / "themes"
TAU = math.tau


def frequency(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def silence(seconds):
    return array("d", [0]) * round(seconds * RATE)


def note(buffer, start, duration, midi, gain, voice="glass", wrap=False):
    """Add a gently attacked harmonic tone with a fully closed release."""
    fundamental = frequency(midi)
    first = round(start * RATE)
    count = round(duration * RATE)
    for offset in range(count):
        index = first + offset
        if not wrap and index >= len(buffer):
            break
        time = offset / RATE
        progress = offset / max(1, count - 1)
        attack = min(1, time / (0.16 if voice == "pad" else 0.014))
        release = min(1, (duration - time) / (0.25 if voice == "pad" else 0.07))
        if voice == "pad":
            envelope = attack * release * (0.85 + 0.15 * math.cos(TAU * progress))
            value = math.sin(TAU * fundamental * time)
            value += 0.14 * math.sin(TAU * 2 * fundamental * time)
        elif voice == "warm":
            envelope = attack * release * math.exp(-3.5 * progress)
            value = math.sin(TAU * fundamental * time)
            value += 0.22 * math.sin(TAU * 2 * fundamental * time) * math.exp(-5 * progress)
            value += 0.07 * math.sin(TAU * 3 * fundamental * time) * math.exp(-7 * progress)
        elif voice == "bass":
            envelope = attack * release * (0.65 + 0.35 * math.exp(-3 * progress))
            value = math.sin(TAU * fundamental * time)
            value += 0.08 * math.sin(TAU * 2 * fundamental * time)
        elif voice == "bell":
            envelope = attack * release * math.exp(-3.2 * progress)
            value = math.sin(TAU * fundamental * time)
            value += 0.16 * math.sin(TAU * 2 * fundamental * time) * math.exp(-6 * progress)
            value += 0.035 * math.sin(TAU * 4 * fundamental * time) * math.exp(-9 * progress)
        elif voice == "pulse":
            envelope = attack * release * math.exp(-2.8 * progress)
            value = math.sin(TAU * fundamental * time)
            value += 0.18 * math.sin(TAU * 2 * fundamental * time) * math.exp(-3 * progress)
            value += 0.055 * math.sin(TAU * 4 * fundamental * time) * math.exp(-6 * progress)
        else:
            envelope = attack * release * math.exp(-4 * progress)
            # A tiny, quickly fading FM component gives the teal pack its glassy ping.
            modulation = 0.35 * math.sin(TAU * 2 * fundamental * time) * math.exp(-8 * progress)
            value = math.sin(TAU * fundamental * time + modulation)
            value += 0.12 * math.sin(TAU * 3 * fundamental * time) * math.exp(-7 * progress)
        buffer[index % len(buffer)] += gain * envelope * value


def write_wav(path, buffer, peak_limit):
    peak = max(abs(value) for value in buffer)
    scale = peak_limit / peak if peak else 1
    pcm = array("h", (round(value * scale * 32767) for value in buffer))
    if struct.pack("=H", 1) != struct.pack("<H", 1):
        pcm.byteswap()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())
    rms = math.sqrt(sum(value * value for value in pcm) / len(pcm)) / 32768
    actual_peak = max(abs(value) for value in pcm) / 32768
    print(
        f"{path.relative_to(ROOT)}: {len(pcm) / RATE:.3f}s, "
        f"peak {20 * math.log10(actual_peak):.1f}dBFS, "
        f"RMS {20 * math.log10(rms):.1f}dBFS, {path.stat().st_size:,} bytes"
    )


def ui_sounds(theme, voice, transpose):
    # Short original interval gestures communicate the event without startling.
    cues = {
        "send": (0.28, [(0, 0.18, 74), (0.075, 0.19, 81)]),
        "complete": (0.74, [(0, 0.38, 74), (0.13, 0.40, 78), (0.27, 0.43, 81)]),
        "approval": (0.63, [(0, 0.27, 78), (0.29, 0.29, 78)]),
        "error": (0.48, [(0, 0.27, 62), (0.17, 0.28, 60)]),
    }
    for event, (duration, tones) in cues.items():
        buffer = silence(duration)
        for start, length, pitch in tones:
            # The warm pack resolves to a major sixth, the glass pack to a fifth.
            adjustment = 2 if voice == "warm" and event == "complete" and pitch == 81 else 0
            note(buffer, start, length, pitch + transpose + adjustment, 0.15, voice)
        write_wav(ROOT / theme / "assets" / f"sound-{event}.wav", buffer, 0.20)


def digital_encore():
    """32 seconds / 16 bars at 120 BPM: mellow digital plucks, pad and bass."""
    buffer = silence(32)
    beat = 0.5
    chords = [(50, 57, 60, 64), (46, 53, 57, 60), (53, 60, 64, 69), (48, 55, 62, 64)]
    # A deliberately sparse arpeggio, not derived from a Miku song.
    patterns = [(0, 2, 1, 3, 2, 1), (1, 3, 2, 0, 3, 2), (2, 1, 3, 0, 1, 2), (0, 3, 1, 2, 3, 1)]
    positions = (0, 0.75, 1.5, 2.5, 3.0, 3.5)
    for bar in range(16):
        start = bar * 4 * beat
        chord = chords[bar % len(chords)]
        for pitch in chord:
            note(buffer, start, 2.5, pitch + 12, 0.025, "pad", True)
        note(buffer, start, 1.9, chord[0] - 12, 0.075, "bass", True)
        for slot, chord_index in zip(positions, patterns[bar % 4]):
            note(buffer, start + slot * beat, 0.67, chord[chord_index] + 24, 0.070, "glass", True)
        # A second-octave sparkle only at phrase ends keeps the loop unobtrusive.
        if bar % 4 == 3:
            note(buffer, start + 1.75, 0.75, chord[2] + 36, 0.020, "glass", True)
    write_wav(ROOT / "hatsune-miku" / "assets" / "encore-loop.wav", buffer, 0.25)


def nine_colors():
    """32 seconds / 12 bars at 90 BPM: soft electric piano and warm harmony."""
    buffer = silence(32)
    beat = 2 / 3
    chords = [(51, 58, 62, 65), (56, 60, 63, 67), (48, 55, 58, 63), (46, 53, 60, 65)]
    patterns = [(1, 2, 0, 3), (2, 0, 3, 1), (3, 1, 2, 0)]
    positions = (0.5, 1.5, 2.25, 3.25)
    for bar in range(12):
        start = bar * 4 * beat
        chord = chords[bar % 4]
        for pitch in chord:
            note(buffer, start, 3.0, pitch + 12, 0.024, "pad", True)
            note(buffer, start + 0.04, 1.5, pitch + 12, 0.025, "warm", True)
        note(buffer, start, 2.4, chord[0] - 12, 0.055, "bass", True)
        for slot, chord_index in zip(positions, patterns[(bar // 4) % 3]):
            note(buffer, start + slot * beat, 0.95, chord[chord_index] + 24, 0.065, "warm", True)
        if bar % 4 == 2:
            note(buffer, start + 3.6 * beat, 0.70, chord[2] + 24, 0.025, "glass", True)
    write_wav(ROOT / "lovelive-muse" / "assets" / "encore-loop.wav", buffer, 0.25)


def character_sounds(theme, voice, cues):
    """Distinct original gestures for the romance and electric character packs."""
    for event, (duration, tones) in cues.items():
        buffer = silence(duration)
        for start, length, pitch in tones:
            note(buffer, start, length, pitch, 0.12, voice)
        write_wav(ROOT / theme / "assets" / f"sound-{event}.wav", buffer, 0.18)


def sweet_promise():
    """32 seconds / 8 bars at 60 BPM: soft piano, bells and a warm pad."""
    character_sounds("nisekoi-onodera", "bell", {
        "send": (0.34, [(0, 0.25, 76), (0.10, 0.23, 81)]),
        "complete": (0.92, [(0, 0.48, 69), (0.17, 0.52, 73), (0.37, 0.51, 80)]),
        "approval": (0.82, [(0, 0.33, 76), (0.42, 0.34, 76)]),
        "error": (0.65, [(0, 0.36, 64), (0.25, 0.36, 62)]),
    })
    buffer = silence(32)
    chords = [(45, 52, 56, 61), (42, 49, 52, 57), (50, 57, 61, 64), (47, 52, 57, 59)]
    patterns = [(2, 0, 3, 1), (1, 3, 0, 2), (3, 1, 2, 0), (0, 2, 1, 3)]
    positions = (0.5, 1.5, 2.25, 3.25)
    for bar in range(8):
        start = bar * 4
        chord = chords[bar % 4]
        for pitch in chord:
            note(buffer, start, 4.35, pitch + 12, 0.018, "pad", True)
            note(buffer, start + 0.04, 2.2, pitch + 12, 0.024, "warm", True)
        note(buffer, start, 3.4, chord[0] - 12, 0.042, "bass", True)
        for slot, chord_index in zip(positions, patterns[bar % 4]):
            note(buffer, start + slot, 1.1, chord[chord_index] + 24, 0.052, "warm", True)
        if bar % 2 == 1:
            note(buffer, start + 2.75, 1.0, chord[2] + 24, 0.018, "bell", True)
    write_wav(ROOT / "nisekoi-onodera" / "assets" / "encore-loop.wav", buffer, 0.23)


def electric_promise():
    """32 seconds / 16 bars at 120 BPM: smooth synth pulses with soft bass."""
    character_sounds("misaka-mikoto", "pulse", {
        "send": (0.26, [(0, 0.16, 71), (0.065, 0.18, 78)]),
        "complete": (0.68, [(0, 0.31, 66), (0.12, 0.34, 73), (0.28, 0.36, 78)]),
        "approval": (0.64, [(0, 0.25, 73), (0.32, 0.28, 78)]),
        "error": (0.49, [(0, 0.26, 59), (0.18, 0.27, 54)]),
    })
    buffer = silence(32)
    beat = 0.5
    chords = [(47, 54, 57, 62), (50, 57, 61, 66), (45, 52, 59, 61), (52, 59, 62, 66)]
    positions = (0.0, 0.75, 1.5, 2.0, 2.75, 3.5)
    patterns = [(2, 0, 3, 1, 2, 3), (0, 2, 1, 3, 0, 2), (3, 1, 0, 2, 3, 1), (1, 3, 2, 0, 1, 2)]
    for bar in range(16):
        start = bar * 4 * beat
        chord = chords[bar % 4]
        for pitch in chord:
            note(buffer, start, 2.35, pitch + 12, 0.020, "pad", True)
        for slot in (0, 1.5, 2.5, 3.25):
            note(buffer, start + slot * beat, 0.34, chord[0] - 12, 0.062, "bass", True)
        for slot, chord_index in zip(positions, patterns[bar % 4]):
            note(buffer, start + slot * beat, 0.46, chord[chord_index] + 24, 0.058, "pulse", True)
        if bar % 4 == 3:
            note(buffer, start + 1.625, 0.55, chord[1] + 36, 0.016, "glass", True)
    write_wav(ROOT / "misaka-mikoto" / "assets" / "encore-loop.wav", buffer, 0.24)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--theme", action="append",
        choices=("hatsune-miku", "lovelive-muse", "nisekoi-onodera", "misaka-mikoto"),
        help="Only generate this theme; may be repeated. Omit to generate all themes.",
    )
    selected = parser.parse_args().theme or [
        "hatsune-miku", "lovelive-muse", "nisekoi-onodera", "misaka-mikoto",
    ]
    for theme in dict.fromkeys(selected):
        if theme == "hatsune-miku":
            ui_sounds(theme, "glass", 0)
            digital_encore()
        elif theme == "lovelive-muse":
            ui_sounds(theme, "warm", -2)
            nine_colors()
        elif theme == "nisekoi-onodera":
            sweet_promise()
        elif theme == "misaka-mikoto":
            electric_promise()
