/**
 * Strip control characters from a URL before embedding it in an OSC 8
 * hyperlink escape sequence. A raw BEL (\x07) is the OSC terminator and a raw
 * ESC (\x1b) starts a new escape sequence — either lets a crafted hyperlink
 * URL (e.g. from rendered untrusted markdown) break out of the link and inject
 * arbitrary terminal control sequences. Removing all C0 controls + DEL closes
 * that; legitimate URLs never contain them. See review-2026-05-30 (security).
 */
export function sanitizeOsc8Url(url: string): string {
  let out = "";
  for (const ch of url) {
    const code = ch.codePointAt(0)!;
    // Drop C0 controls (0x00–0x1f) and DEL (0x7f).
    if (code <= 0x1f || code === 0x7f) continue;
    out += ch;
  }
  return out;
}
