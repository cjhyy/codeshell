/**
 * DiffView — renders a unified git diff string. Delegates each row to the
 * shared <DiffLine> primitive so coloring matches the rest of the app
 * (PermissionPrompt, ToolCallResult).
 *
 * File headers (`+++ / ---` / `diff --git`) keep their bold/yellow treatment
 * since they're not part of the actual hunk body.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";
import { DiffLine, classifyDiffLine } from "./DiffLine.js";

interface DiffViewProps {
  diff: string;
  maxLines?: number;
}

export function DiffView({ diff, maxLines = 100 }: DiffViewProps) {
  const allLines = diff.split("\n");
  const lines = allLines.slice(0, maxLines);

  return (
    <Box flexDirection="column" marginLeft={1}>
      {lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
      {allLines.length > maxLines && (
        <Text dim>{`  ... ${allLines.length - maxLines} more lines`}</Text>
      )}
    </Box>
  );
}

function DiffRow({ line }: { line: string }) {
  // Git-style file headers: render bold/yellow rather than diff bands so they
  // stand out as section dividers (DiffLine treats `+++ / ---` as context).
  if (line.startsWith("+++") || line.startsWith("---")) {
    return <Text bold>{line}</Text>;
  }
  if (line.startsWith("diff --git")) {
    return <Text bold color="ansi:yellow">{line}</Text>;
  }
  const { kind, text } = classifyDiffLine(line);
  return <DiffLine kind={kind} text={text} />;
}
