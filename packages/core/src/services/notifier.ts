/**
 * Notifier service — desktop/system notifications.
 *
 * Sends notifications when tasks complete, agents finish, or errors occur.
 * Falls back gracefully when no notification system is available.
 */

import { execFileSync } from "node:child_process";

export interface NotificationOptions {
  title: string;
  message: string;
  sound?: boolean;
  /** Urgency level: low, normal, critical */
  urgency?: "low" | "normal" | "critical";
}

/**
 * Send a desktop notification.
 */
export function notify(options: NotificationOptions): void {
  const { title, message, sound = false, urgency = "normal" } = options;

  try {
    if (process.platform === "darwin") {
      // macOS: osascript. Pass the script as a single -e argv element via
      // execFileSync (no shell), so title/message are never seen by the shell.
      execFileSync("osascript", buildOsascriptArgs(title, message, sound), { timeout: 5000 });
    } else if (process.platform === "linux") {
      // Linux: notify-send. argv keeps title/message as separate tokens.
      execFileSync("notify-send", buildNotifySendArgs(title, message, urgency), { timeout: 5000 });
    } else if (process.platform === "win32") {
      // Windows: PowerShell toast. The script is one -Command argv element
      // (no outer shell); title/message are escaped for PowerShell single
      // quotes (' → '').
      execFileSync("powershell.exe", buildPowershellArgs(title, message), { timeout: 5000 });
    }
  } catch {
    // Silently fail — notifications are best-effort
  }
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

/** Build the osascript argv (a single `-e <script>` pair). */
export function buildOsascriptArgs(title: string, message: string, sound: boolean): string[] {
  const soundClause = sound ? ' sound name "default"' : "";
  const script =
    `display notification "${escapeAppleScriptString(message)}"` +
    ` with title "${escapeAppleScriptString(title)}"${soundClause}`;
  return ["-e", script];
}

/** Build the notify-send argv with title/message as separate tokens. */
export function buildNotifySendArgs(
  title: string,
  message: string,
  urgency: "low" | "normal" | "critical",
): string[] {
  return ["-u", urgency, title, message];
}

/** Build the powershell.exe argv (a single `-Command <script>` element). */
export function buildPowershellArgs(title: string, message: string): string[] {
  const esc = (s: string): string => s.replace(/'/g, "''").replace(/\n/g, " ");
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$text = $xml.GetElementsByTagName('text')",
    `$text[0].AppendChild($xml.CreateTextNode('${esc(title)}')) | Out-Null`,
    `$text[1].AppendChild($xml.CreateTextNode('${esc(message)}')) | Out-Null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CodeShell').Show($toast)",
  ].join("; ");
  return ["-NoProfile", "-Command", ps];
}

/**
 * Send a notification that a task/agent has completed.
 */
export function notifyComplete(taskName: string, duration?: number): void {
  const durationStr = duration ? ` (${(duration / 1000).toFixed(1)}s)` : "";
  notify({
    title: "Code Shell",
    message: `✓ ${taskName} completed${durationStr}`,
    sound: true,
  });
}

/**
 * Send an error notification.
 */
export function notifyError(context: string, error: string): void {
  notify({
    title: "Code Shell Error",
    message: `✗ ${context}: ${error.slice(0, 100)}`,
    urgency: "critical",
  });
}
