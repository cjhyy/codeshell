/**
 * Voice mode — STT (speech-to-text) and TTS (text-to-speech) integration.
 *
 * STT: Uses Whisper API via OpenRouter (or local whisper.cpp)
 * TTS: Uses system speech synthesis (macOS `say`, Linux `espeak`)
 */

import { execSync, spawn } from "node:child_process";

export interface VoiceConfig {
  sttProvider?: "whisper-api" | "local";
  ttsProvider?: "system" | "none";
  apiKey?: string;
  baseUrl?: string;
}

let _enabled = false;
let _config: VoiceConfig = {};

export function isVoiceEnabled(): boolean {
  return _enabled;
}

export function enableVoice(config?: VoiceConfig): void {
  _enabled = true;
  _config = config ?? {};
}

export function disableVoice(): void {
  _enabled = false;
}

// ─── TTS (Text-to-Speech) ────────────────────────────────────────

/**
 * Speak text using system TTS.
 */
export function speak(text: string): void {
  if (!_enabled) return;
  if (_config.ttsProvider === "none") return;

  const platform = process.platform;
  try {
    if (platform === "darwin") {
      // macOS: use `say` command (non-blocking)
      const child = spawn("say", [text], { stdio: "ignore", detached: true });
      child.unref();
    } else if (platform === "linux") {
      // Linux: use espeak (non-blocking)
      const child = spawn("espeak", [text], { stdio: "ignore", detached: true });
      child.unref();
    } else if (platform === "win32") {
      // Windows: use PowerShell
      const child = spawn("powershell", [
        "-Command",
        `Add-Type -AssemblyName System.Speech; ` +
        `$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$synth.Speak('${text.replace(/'/g, "''")}')`,
      ], { stdio: "ignore", detached: true });
      child.unref();
    }
  } catch {
    // TTS not available
  }
}

/**
 * Stop any currently speaking TTS.
 */
export function stopSpeaking(): void {
  try {
    if (process.platform === "darwin") {
      execSync("killall say 2>/dev/null", { timeout: 3000 });
    } else if (process.platform === "linux") {
      execSync("killall espeak 2>/dev/null", { timeout: 3000 });
    }
  } catch {
    // Nothing speaking
  }
}

// ─── STT (Speech-to-Text) ────────────────────────────────────────

/**
 * Check if audio recording is available.
 */
export function isRecordingAvailable(): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("which rec 2>/dev/null || which sox 2>/dev/null", { timeout: 3000 });
      return true;
    }
    if (process.platform === "linux") {
      execSync("which arecord 2>/dev/null || which sox 2>/dev/null", { timeout: 3000 });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Record audio and transcribe via Whisper API.
 * Returns the transcribed text.
 *
 * Note: Full implementation requires audio capture setup.
 * This is a stub that shows the architecture.
 */
export async function recordAndTranscribe(_durationSeconds = 10): Promise<string> {
  if (!_config.apiKey) {
    return "Error: API key required for voice transcription. Set in settings.";
  }
  // Stub: In a full implementation, this would:
  // 1. Record audio to a temp file using sox/arecord
  // 2. Send to Whisper API via OpenRouter
  // 3. Return transcribed text
  return "Voice transcription is not yet fully implemented. Use text input.";
}
