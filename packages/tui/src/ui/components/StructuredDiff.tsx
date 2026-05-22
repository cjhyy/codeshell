/**
 * StructuredDiff — renders file edit diffs (old_string → new_string)
 * with side-by-side or unified view. Row rendering delegates to the
 * shared <DiffLine> so styling stays consistent across the app.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";
import { DiffLine } from "./DiffLine.js";

interface StructuredDiffProps {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export function StructuredDiff({ filePath, oldString, newString, replaceAll }: StructuredDiffProps) {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  // Simple unified diff
  const diffLines = computeUnifiedDiff(oldLines, newLines);

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text bold color="ansi:yellow">
        {filePath} {replaceAll ? "(replace all)" : ""}
      </Text>
      <Box flexDirection="column">
        {diffLines.map((line, i) => (
          <DiffLineComponent key={i} line={line} />
        ))}
      </Box>
    </Box>
  );
}

type DiffLineType = "same" | "add" | "remove" | "header";

interface DiffEntry {
  type: DiffLineType;
  text: string;
}

function DiffLineComponent({ line }: { line: DiffEntry }) {
  switch (line.type) {
    case "add":
      return <DiffLine kind="add" text={line.text} />;
    case "remove":
      return <DiffLine kind="remove" text={line.text} />;
    case "header":
      return <DiffLine kind="hunk" text={line.text} />;
    case "same":
      return <DiffLine kind="context" text={line.text} />;
  }
}

function computeUnifiedDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const result: DiffEntry[] = [];

  // Simple LCS-based diff
  const lcs = longestCommonSubsequence(oldLines, newLines);
  let oi = 0;
  let ni = 0;
  let li = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      result.push({ type: "same", text: oldLines[oi] });
      oi++;
      ni++;
      li++;
    } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
      result.push({ type: "remove", text: oldLines[oi] });
      oi++;
    } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
      result.push({ type: "add", text: newLines[ni] });
      ni++;
    } else {
      break;
    }
  }

  return result;
}

function longestCommonSubsequence(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;

  // Limit for performance — skip LCS for very large diffs
  if (m > 500 || n > 500) {
    // Fallback: show all old as removed, all new as added
    return [];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}
