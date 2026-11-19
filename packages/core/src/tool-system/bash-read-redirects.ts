/**
 * Narrow, read-only shell shapes that the Bash classifier may accept without
 * treating them as arbitrary redirection or directory changes.
 *
 * Accepted redirections (each still requires the rest of the segment to be
 * safe-read; see classifyBashCommand):
 *   - input from a plain path: `cmd < file`, `cmd 0< file` (not /dev/tcp|udp)
 *   - output discards: `>/dev/null`, `1>/dev/null`, `2>/dev/null`, `&>/dev/null`
 *     (and the `>>` spellings, which are equally inert for /dev/null)
 *   - stream merges: `2>&1`, `1>&2`, `>&2`
 *
 * Everything else stays dangerous: output to a real file, heredocs `<<`,
 * here-strings `<<<`, `<>`, `<&`/other fd duplication, `>|`, process
 * substitution, and any target containing expansions, substitutions or globs.
 */

/** A recognized benign redirection starting at a `<`, `>` or `&>` operator. */
export interface BenignRedirect {
  /** Index just past the redirection target. */
  end: number;
  /** Number of trailing fd-number characters in the pending word buffer. */
  fdPrefixLength: number;
}

const BARE_PLAIN_WORD = /^[\p{L}\p{N}_~./@%+,:=-]+$/u;

/** Characters that may legally follow a redirection target. */
function isWordBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || ";&|<>)".includes(ch);
}

/**
 * True when `raw` is a single shell word that expands to itself: a bare word of
 * ordinary path characters, a single-quoted string, or a double-quoted string
 * with no expansion or escape syntax. Leading `~` (tilde expansion) is allowed,
 * as it is for ordinary read arguments.
 */
export function isPlainShellWord(raw: string): boolean {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return !raw.slice(1, -1).includes("'");
  }
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return !/["$`\\!]/.test(raw.slice(1, -1));
  }
  return BARE_PLAIN_WORD.test(raw);
}

function unquote(raw: string): string {
  return /^(['"]).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
}

/** Read one redirection target word; null when it is not a plain word. */
function readPlainWord(input: string, start: number): { raw: string; end: number } | null {
  let j = start;
  while (input[j] === " " || input[j] === "\t") j++;
  const first = input[j];
  let end: number;
  if (first === "'" || first === '"') {
    const close = input.indexOf(first, j + 1);
    if (close < 0) return null;
    end = close + 1;
  } else {
    end = j;
    while (end < input.length && !isWordBoundary(input[end]) && !"'\"".includes(input[end])) {
      end++;
    }
  }
  const raw = input.slice(j, end);
  if (raw.length === 0 || !isWordBoundary(input[end]) || !isPlainShellWord(raw)) return null;
  return { raw, end };
}

/**
 * Try to consume a benign redirection whose operator starts at `start`
 * (`<`, `>`, or the `&` of `&>`). `pending` is the current unflushed word
 * buffer, used to recognize a standalone fd number such as the `2` in
 * `ls 2>/dev/null`. Returns null for anything not on the allowlist.
 */
export function matchBenignRedirect(
  input: string,
  start: number,
  pending: string,
): BenignRedirect | null {
  let fd = "";
  let fdPrefixLength = 0;
  let op = start;
  if (input[start] === "&") {
    fd = "&";
    op = start + 1;
    if (input[op] !== ">") return null;
  } else {
    const digits = /(?:^|\s)(\d+)$/.exec(pending);
    if (digits) {
      fd = digits[1];
      fdPrefixLength = fd.length;
    }
  }

  if (input[op] === "<") {
    if (fd !== "" && fd !== "0") return null;
    // `<<` heredoc, `<<<` here-string, `<&` dup, `<>` read-write, `<(` process substitution.
    if ("<&>(".includes(input[op + 1] ?? "")) return null;
    const word = readPlainWord(input, op + 1);
    // Bash itself opens a network socket for `< /dev/tcp/host/port`.
    if (!word || /^\/+dev\/+(?:tcp|udp)\//.test(unquote(word.raw))) return null;
    return { end: word.end, fdPrefixLength };
  }

  if (input[op] !== ">") return null;
  let j = op + 1;
  const append = input[j] === ">";
  if (append) j++;
  if (input[j] === "&") {
    if (append || fd === "&") return null;
    const dup = /^\d+/.exec(input.slice(j + 1))?.[0];
    if (!dup || !isWordBoundary(input[j + 1 + dup.length])) return null;
    const merge = (fd === "2" && dup === "1") || ((fd === "" || fd === "1") && dup === "2");
    return merge ? { end: j + 1 + dup.length, fdPrefixLength } : null;
  }
  // `>|` clobber and `>(` process substitution never qualify.
  if (input[j] === "|" || input[j] === "(") return null;
  if (fd !== "" && fd !== "1" && fd !== "2" && fd !== "&") return null;
  const word = readPlainWord(input, j);
  if (!word || unquote(word.raw) !== "/dev/null") return null;
  return { end: word.end, fdPrefixLength };
}

/**
 * True for `cd` to a plain directory (or bare `cd` / `cd -`). The Bash tool
 * spawns a fresh shell per call, so the directory change only affects the
 * rest of the same command line.
 */
export function isPlainCdSegment(segment: string): boolean {
  const match = /^cd(?:\s+(.*))?$/s.exec(segment.trim());
  if (!match) return false;
  const arg = match[1]?.trim();
  if (arg === undefined || arg === "" || arg === "-") return true;
  const word = readPlainWord(arg, 0);
  if (!word || word.end !== arg.length) return false;
  return !unquote(word.raw).startsWith("-");
}
