/**
 * Process-host invalidation bridge for built-ins that persist settings-like
 * resources outside the renderer. Desktop wires one sink that forwards the
 * existing agent/settingsChanged notification; headless hosts may leave it
 * unset and pick the change up on their next settings load.
 */

export type SettingsChangedSink = () => void;

let settingsChangedSink: SettingsChangedSink | null = null;

export function setSettingsChangedSink(sink: SettingsChangedSink | null): void {
  settingsChangedSink = sink;
}

export function notifySettingsChanged(): void {
  try {
    settingsChangedSink?.();
  } catch {
    // Persistence already succeeded. Host invalidation is best-effort.
  }
}
