const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const BOX_RE = /[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝═║╠╣╦╩╬▀▄█▌▐░▒▓·]+/g;

export interface NoiseResult {
  isNoise: boolean;
  reason: string;
  cleaned: string;
}

export function detectPastedNoise(task: string): NoiseResult {
  const original = task.length;
  if (original < 10) return { isNoise: false, reason: "short", cleaned: task };

  const stripped = task
    .replace(ANSI_RE, "")
    .replace(BOX_RE, "")
    .replace(/\r/g, "\n")
    .trim();

  if (stripped.length === 0) {
    return { isNoise: true, reason: "all ANSI/box chars", cleaned: stripped };
  }

  const signalRatio = stripped.length / original;
  if (signalRatio < 0.3 && original > 100) {
    return {
      isNoise: true,
      reason: `signal/noise ratio ${(signalRatio * 100).toFixed(0)}%`,
      cleaned: stripped,
    };
  }

  return { isNoise: false, reason: "ok", cleaned: stripped };
}
