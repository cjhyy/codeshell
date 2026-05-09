/**
 * DiffView — Ink component for rendering git diffs with color coding.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";

interface DiffViewProps {
  diff: string;
  maxLines?: number;
}

export function DiffView({ diff, maxLines = 100 }: DiffViewProps) {
  const lines = diff.split("\n").slice(0, maxLines);

  return (
    <Box flexDirection="column" marginLeft={1}>
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
      {diff.split("\n").length > maxLines && (
        <Text dim>{`  ... ${diff.split("\n").length - maxLines} more lines`}</Text>
      )}
    </Box>
  );
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return <Text bold>{line}</Text>;
  }
  if (line.startsWith("@@")) {
    return <Text color="ansi:cyan">{line}</Text>;
  }
  if (line.startsWith("+")) {
    return <Text color="ansi:green">{line}</Text>;
  }
  if (line.startsWith("-")) {
    return <Text color="ansi:red">{line}</Text>;
  }
  if (line.startsWith("diff --git")) {
    return <Text bold color="ansi:yellow">{line}</Text>;
  }
  return <Text dim>{line}</Text>;
}
