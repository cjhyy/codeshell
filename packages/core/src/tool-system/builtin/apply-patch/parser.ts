// Adapted from openai/codex codex-rs/apply-patch/src/parser.rs (Apache-2.0).
//
// V4A patch grammar (lenient form):
//
//   start        := begin_patch hunk* end_patch
//   begin_patch  := "*** Begin Patch" LF
//   end_patch    := "*** End Patch" LF?
//   hunk         := add_hunk | delete_hunk | update_hunk
//   add_hunk     := "*** Add File: " path LF ("+" line LF)+
//   delete_hunk  := "*** Delete File: " path LF
//   update_hunk  := "*** Update File: " path LF change_move? change?
//   change_move  := "*** Move to: " path LF
//   change       := (change_context | change_line)+ eof_line?
//   change_line  := (" " | "+" | "-") text LF
//   eof_line     := "*** End of File" LF
//
// Lenient extras:
//   - Leading/trailing whitespace around begin/end markers tolerated.
//   - First Update chunk may omit the leading `@@` context marker.
//   - Patch text may be wrapped in <<EOF / <<'EOF' / <<"EOF" heredoc; we strip
//     it so misformatted shell-style invocations still parse.

import { Hunk, PatchParseError, UpdateFileChunk } from "./types.js";

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

export interface ParsedPatch {
  hunks: Hunk[];
  /** The patch body with any heredoc wrapper stripped. */
  patch: string;
}

export type ParseMode = "strict" | "lenient";

export function parsePatch(text: string, mode: ParseMode = "lenient"): ParsedPatch {
  const trimmed = text.trim();
  const lines = trimmed.length === 0 ? [] : trimmed.split("\n");

  const inner =
    mode === "strict"
      ? checkBoundariesStrict(lines)
      : checkBoundariesLenient(lines);

  const hunks: Hunk[] = [];
  let lineNumber = 2;
  let i = 0;
  while (i < inner.body.length) {
    const { hunk, consumed } = parseOneHunk(inner.body, i, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    i += consumed;
  }

  return { hunks, patch: inner.allLines.join("\n") };
}

interface Boundaries {
  /** Lines including the begin/end markers. */
  allLines: string[];
  /** Lines between the markers (the hunk body). */
  body: string[];
}

function checkBoundariesStrict(lines: string[]): Boundaries {
  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();

  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchParseError(
      "InvalidPatch",
      "The first line of the patch must be '*** Begin Patch'",
    );
  }
  if (lines.length < 2 || last !== END_PATCH_MARKER) {
    throw new PatchParseError(
      "InvalidPatch",
      "The last line of the patch must be '*** End Patch'",
    );
  }
  return { allLines: lines, body: lines.slice(1, lines.length - 1) };
}

function checkBoundariesLenient(lines: string[]): Boundaries {
  try {
    return checkBoundariesStrict(lines);
  } catch (err) {
    const original = err as PatchParseError;
    if (lines.length >= 4) {
      const first = lines[0];
      const last = lines[lines.length - 1];
      const isHeredoc =
        (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
        last.endsWith("EOF");
      if (isHeredoc) {
        return checkBoundariesStrict(lines.slice(1, lines.length - 1));
      }
    }
    throw original;
  }
}

interface OneHunk {
  hunk: Hunk;
  consumed: number;
}

function parseOneHunk(lines: string[], offset: number, lineNumber: number): OneHunk {
  const first = lines[offset].trim();

  if (first.startsWith(ADD_FILE_MARKER)) {
    const path = first.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let consumed = 1;
    for (let i = offset + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("+")) {
        contents += line.slice(1) + "\n";
        consumed++;
      } else {
        break;
      }
    }
    return { hunk: { kind: "add", path, contents }, consumed };
  }

  if (first.startsWith(DELETE_FILE_MARKER)) {
    return {
      hunk: { kind: "delete", path: first.slice(DELETE_FILE_MARKER.length) },
      consumed: 1,
    };
  }

  if (first.startsWith(UPDATE_FILE_MARKER)) {
    const path = first.slice(UPDATE_FILE_MARKER.length);
    let cursor = offset + 1;
    let consumed = 1;

    let movePath: string | undefined;
    if (cursor < lines.length && lines[cursor].startsWith(MOVE_TO_MARKER)) {
      movePath = lines[cursor].slice(MOVE_TO_MARKER.length);
      cursor++;
      consumed++;
    }

    const chunks: UpdateFileChunk[] = [];
    while (cursor < lines.length) {
      // Skip blank lines between chunks.
      if (lines[cursor].trim() === "") {
        cursor++;
        consumed++;
        continue;
      }
      // Stop at any other top-level marker (`*** ...`).
      if (lines[cursor].startsWith("*")) break;

      const result = parseUpdateChunk(
        lines,
        cursor,
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(result.chunk);
      cursor += result.consumed;
      consumed += result.consumed;
    }

    if (chunks.length === 0) {
      throw new PatchParseError(
        "InvalidHunk",
        `Update file hunk for path '${path}' is empty`,
        lineNumber,
      );
    }

    return {
      hunk: { kind: "update", path, movePath, chunks },
      consumed,
    };
  }

  throw new PatchParseError(
    "InvalidHunk",
    `'${first}' is not a valid hunk header. Valid hunk headers: ` +
      `'*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  );
}

interface ChunkParseResult {
  chunk: UpdateFileChunk;
  consumed: number;
}

function parseUpdateChunk(
  lines: string[],
  offset: number,
  lineNumber: number,
  allowMissingContext: boolean,
): ChunkParseResult {
  if (offset >= lines.length) {
    throw new PatchParseError(
      "InvalidHunk",
      "Update hunk does not contain any lines",
      lineNumber,
    );
  }

  const head = lines[offset];
  let changeContext: string | undefined;
  let cursor = offset;

  if (head === EMPTY_CHANGE_CONTEXT_MARKER) {
    cursor = offset + 1;
  } else if (head.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = head.slice(CHANGE_CONTEXT_MARKER.length);
    cursor = offset + 1;
  } else if (!allowMissingContext) {
    throw new PatchParseError(
      "InvalidHunk",
      `Expected update hunk to start with a @@ context marker, got: '${head}'`,
      lineNumber,
    );
  }

  if (cursor >= lines.length) {
    throw new PatchParseError(
      "InvalidHunk",
      "Update hunk does not contain any lines",
      lineNumber + 1,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let bodyConsumed = 0;

  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i];
    if (line === EOF_MARKER) {
      if (bodyConsumed === 0) {
        throw new PatchParseError(
          "InvalidHunk",
          "Update hunk does not contain any lines",
          lineNumber + 1,
        );
      }
      isEndOfFile = true;
      bodyConsumed++;
      break;
    }

    if (line.length === 0) {
      // Blank line — treat as a context line containing the empty string.
      oldLines.push("");
      newLines.push("");
      bodyConsumed++;
      continue;
    }

    const marker = line[0];
    const rest = line.slice(1);
    if (marker === " ") {
      oldLines.push(rest);
      newLines.push(rest);
    } else if (marker === "+") {
      newLines.push(rest);
    } else if (marker === "-") {
      oldLines.push(rest);
    } else {
      // First unrecognized character at position 0 with no body yet → error.
      // Otherwise, assume this is the start of the next hunk.
      if (bodyConsumed === 0) {
        throw new PatchParseError(
          "InvalidHunk",
          `Unexpected line found in update hunk: '${line}'. Every line should start ` +
            `with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNumber + 1,
        );
      }
      break;
    }
    bodyConsumed++;
  }

  return {
    chunk: {
      changeContext,
      oldLines,
      newLines,
      isEndOfFile,
    },
    consumed: bodyConsumed + (cursor - offset),
  };
}
