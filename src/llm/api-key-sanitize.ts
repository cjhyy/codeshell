/**
 * sanitizeApiKey — defensive cleanup for API keys pasted via the wizard.
 *
 * Windows terminals (ConPTY, legacy cmd.exe, IME-active states) are the main
 * source of breakage: bracketed-paste residue, CR endings, zero-width chars
 * pulled in from rich-text sources (Notion / OneNote / web pages), full-width
 * spaces from CJK IME, smart quotes from word processors. None of these are
 * valid in any real provider's API key, so we strip them and warn.
 */

const BRACKETED_PASTE_START = /^\x1b\[200~/;
const BRACKETED_PASTE_END = /\x1b\[201~$/;

// Zero-width + BOM + word joiner. These render as nothing but break auth.
// U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+2060 WORD JOINER, U+FEFF BOM.
const INVISIBLE_CHARS = /[​-‍⁠﻿]/g;

// CJK full-width space (U+3000) — IME residue. Normal space is U+0020.
const FULLWIDTH_SPACE = /　/g;

// Smart quotes — Word / web pages auto-convert ASCII quotes. Real keys
// never contain quotes, so strip them rather than replace.
// U+2018 ‘, U+2019 ’, U+201C “, U+201D ”.
const SMART_QUOTES = /[‘’“”]/g;

// All C0 (0x00-0x1F) and C1 (0x7F-0x9F) control chars, plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/g;

export type SanitizeResult = {
  value: string;
  changed: boolean;
  warnings: string[];
};

export function sanitizeApiKey(raw: string): SanitizeResult {
  const warnings: string[] = [];
  let v = raw;

  // 1. Strip bracketed-paste wrapper if it leaked through parse-keypress.
  if (BRACKETED_PASTE_START.test(v) || BRACKETED_PASTE_END.test(v)) {
    v = v.replace(BRACKETED_PASTE_START, "").replace(BRACKETED_PASTE_END, "");
    warnings.push("已剥离终端粘贴包裹符");
  }

  // 2. Drop every line break — keys are single-line.
  if (/[\r\n]/.test(v)) {
    v = v.replace(/[\r\n]+/g, "");
    warnings.push("已移除换行符");
  }

  // 3. Invisible / zero-width characters.
  if (INVISIBLE_CHARS.test(v)) {
    v = v.replace(INVISIBLE_CHARS, "");
    warnings.push("已移除零宽字符");
  }

  // 4. Full-width space (IME).
  if (FULLWIDTH_SPACE.test(v)) {
    v = v.replace(FULLWIDTH_SPACE, "");
    warnings.push("已移除全角空格");
  }

  // 5. Smart quotes (Word/web).
  if (SMART_QUOTES.test(v)) {
    v = v.replace(SMART_QUOTES, "");
    warnings.push("已移除中文/智能引号");
  }

  // 6. Any other control character (NUL, ESC, …).
  if (CONTROL_CHARS.test(v)) {
    v = v.replace(CONTROL_CHARS, "");
    warnings.push("已移除控制字符");
  }

  // 7. Trim ASCII whitespace last.
  const trimmed = v.trim();
  if (trimmed !== v) {
    v = trimmed;
    // Don't warn on plain leading/trailing space — too noisy and obvious.
  }

  const changed = v !== raw;
  return { value: v, changed, warnings };
}

/**
 * Returns true when the sanitized key contains any non-ASCII-printable
 * character. Real provider keys are uniformly ASCII (`[A-Za-z0-9_\-.]`-ish),
 * so a stray non-ASCII char almost certainly means the user pasted the wrong
 * thing (e.g. the surrounding sentence in Chinese).
 */
export function hasNonAsciiPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return true;
  }
  return false;
}
