/**
 * PermissionDialog — interactive permission confirmation dialog.
 *
 * Shown when a tool needs user approval (permission decision = "ask").
 */
import React, { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";

interface PermissionDialogProps {
  toolName: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  onDecision: (approved: boolean, permanent?: boolean) => void;
}

export function PermissionDialog({ toolName, description, riskLevel, onDecision }: PermissionDialogProps) {
  const [selected, setSelected] = useState(0);

  const riskColor = riskLevel === "high" ? "red" : riskLevel === "medium" ? "yellow" : "green";
  const options = [
    { label: "Allow once", key: "y" },
    { label: "Always allow", key: "a" },
    { label: "Deny", key: "n" },
  ];

  useInput((input, key) => {
    if (input === "y" || input === "Y") {
      onDecision(true, false);
    } else if (input === "a" || input === "A") {
      onDecision(true, true);
    } else if (input === "n" || input === "N" || key.escape) {
      onDecision(false);
    } else if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow) {
      setSelected((s) => Math.min(options.length - 1, s + 1));
    } else if (key.return) {
      if (selected === 0) onDecision(true, false);
      else if (selected === 1) onDecision(true, true);
      else onDecision(false);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1}>
      <Text bold color={riskColor}>
        Permission Required
      </Text>
      <Text>
        <Text bold>{toolName}</Text>
        <Text dim> — {description}</Text>
      </Text>
      <Text dim>Risk: {riskLevel}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => (
          <Text key={opt.key}>
            {i === selected ? <Text color="ansi:cyan">{"❯ "}</Text> : "  "}
            <Text bold={i === selected}>{opt.label}</Text>
            <Text dim> ({opt.key})</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
