/**
 * CodeBlock — syntax-highlighted code block with language tag and optional line numbers.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}

/** Total dash-run width after the corner glyph; top and bottom borders match. */
const BORDER_FILL = 44;

export function CodeBlock({ code, language, showLineNumbers }: CodeBlockProps) {
  let highlighted = code;
  try {
    // Dynamic import to avoid bundling issues
    const { highlight } = require("cli-highlight");
    highlighted = highlight(code, { language: language || "auto", ignoreIllegals: true });
  } catch {
    // Fallback to plain code
  }

  const lines = highlighted.split("\n");

  return (
    <Box flexDirection="column" marginY={0} marginLeft={1}>
      {language && (
        // Total run after ╭ is `─ <lang> ` (3 + len) + (TAG_FILL - len) dashes
        // = TAG_FILL + 3, kept equal to the bottom border below.
        <Text dim>{`  ╭─ ${language} ${"─".repeat(Math.max(0, BORDER_FILL - 3 - language.length))}`}</Text>
      )}
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Box key={i}>
            {showLineNumbers && (
              <Text dim>{String(i + 1).padStart(3)} │ </Text>
            )}
            {!showLineNumbers && <Text dim>  │ </Text>}
            <Text>{line}</Text>
          </Box>
        ))}
      </Box>
      <Text dim>{`  ╰${"─".repeat(BORDER_FILL)}`}</Text>
    </Box>
  );
}
