#!/usr/bin/env python3
"""Reproduce the two theme packs' original UI cues and instrumental loops.

Python standard library only. No samples, existing melodies, or vocal models are
used. Files are mono 44.1 kHz PCM16 WAV, with conservative peaks and zero-crossing
envelopes. Notes in instrumental loops wrap their tails across the loop boundary.
"""

from array import array
from pathlib import Path
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


if __name__ == "__main__":
    ui_sounds("hatsune-miku", "glass", 0)
    ui_sounds("lovelive-muse", "warm", -2)
    digital_encore()
    nine_colors()
