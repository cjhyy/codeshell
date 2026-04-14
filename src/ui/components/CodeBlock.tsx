/**
 * CodeBlock — syntax-highlighted code block with language tag and optional line numbers.
 */
import React from "react";
import { Box, Text } from "../../ink/index.js";

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
}

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
        <Text dim>{`  ╭─ ${language} ${"─".repeat(Math.max(0, 40 - language.length))}`}</Text>
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
      <Text dim>{`  ╰${"─".repeat(44)}`}</Text>
    </Box>
  );
}
