/**
 * Build the argv to open a URL in the system browser, per platform. Returned
 * as { cmd, args } for execFile (no shell), so the URL is a single literal
 * argument and can't be shell-interpreted — the old code interpolated it into
 * an exec() shell string (review-2026-05-30, security).
 *
 * Windows uses `cmd /c start "" <url>`: `start`'s first quoted arg is the
 * window title, so an empty title slot keeps the URL from being read as one.
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}
