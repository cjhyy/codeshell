/**
 * Notifier service — desktop/system notifications.
 *
 * Sends notifications when tasks complete, agents finish, or errors occur.
 * Falls back gracefully when no notification system is available.
 */

import { execSync } from "node:child_process";

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
      // macOS: osascript
      const soundFlag = sound ? 'sound name "default"' : "";
      execSync(
        `osascript -e 'display notification "${escape(message)}" with title "${escape(title)}" ${soundFlag}'`,
        { timeout: 5000 },
      );
    } else if (process.platform === "linux") {
      // Linux: notify-send
      const urgencyFlag = urgency === "critical" ? "-u critical" : urgency === "low" ? "-u low" : "-u normal";
      execSync(`notify-send ${urgencyFlag} "${escape(title)}" "${escape(message)}"`, {
        timeout: 5000,
      });
    } else if (process.platform === "win32") {
      // Windows: PowerShell toast
      const ps = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
        $text = $xml.GetElementsByTagName('text')
        $text[0].AppendChild($xml.CreateTextNode('${escape(title)}')) | Out-Null
        $text[1].AppendChild($xml.CreateTextNode('${escape(message)}')) | Out-Null
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('CodeShell').Show($toast)
      `.trim();
      execSync(`powershell.exe -NoProfile -Command "${ps.replace(/\n/g, "; ")}"`, {
        timeout: 5000,
      });
    }
  } catch {
    // Silently fail — notifications are best-effort
  }
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

function escape(str: string): string {
  return str.replace(/['"\\]/g, "\\$&").replace(/\n/g, " ");
}
