/**
 * PermissionPrompt — interactive tool permission dialog.
 * Shows tool name, args summary, risk level.
 * [y] Allow  [n] Deny  [a] Always allow  [d] Always deny
 */
import { Box, Text, useInput } from "../../ink/index.js";

interface PermissionPromptProps {
  toolName: string;
  description: string;
  riskLevel: string;
  onDecision: (approved: boolean, always: boolean) => void;
}

export function PermissionPrompt({ toolName, description, riskLevel, onDecision }: PermissionPromptProps) {
  useInput((ch) => {
    switch (ch.toLowerCase()) {
      case "y":
        onDecision(true, false);
        break;
      case "n":
        onDecision(false, false);
        break;
      case "a":
        onDecision(true, true);
        break;
      case "d":
        onDecision(false, true);
        break;
    }
  });

  const riskColor = riskLevel === "high" ? "red" : riskLevel === "medium" ? "yellow" : "green";

  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      <Box>
        <Text color="ansi:yellow" bold>{"? "}</Text>
        <Text bold>{toolName}</Text>
        <Text dim>{" — "}{description}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text color={riskColor}>risk: {riskLevel}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dim>[</Text>
        <Text color="ansi:green" bold>y</Text>
        <Text dim>] Allow  [</Text>
        <Text color="ansi:red" bold>n</Text>
        <Text dim>] Deny  [</Text>
        <Text color="ansi:cyan" bold>a</Text>
        <Text dim>] Always allow  [</Text>
        <Text color="ansi:magenta" bold>d</Text>
        <Text dim>] Always deny</Text>
      </Box>
    </Box>
  );
}
