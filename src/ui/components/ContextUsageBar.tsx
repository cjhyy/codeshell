/**
 * ContextUsageBar — shows context window usage as a progress bar.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";

interface ContextUsageBarProps {
  usedTokens: number;
  maxTokens: number;
  width?: number;
}

export function ContextUsageBar({ usedTokens, maxTokens, width = 30 }: ContextUsageBarProps) {
  const percent = Math.min((usedTokens / maxTokens) * 100, 100);
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;

  const color = percent > 80 ? "red" : percent > 60 ? "yellow" : "green";
  const bar = "█".repeat(filled) + "░".repeat(empty);

  const usedStr = formatTokens(usedTokens);
  const maxStr = formatTokens(maxTokens);

  return (
    <Box>
      <Text dim>Context: </Text>
      <Text color={color}>{bar}</Text>
      <Text dim> {usedStr}/{maxStr} ({percent.toFixed(0)}%)</Text>
    </Box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}
