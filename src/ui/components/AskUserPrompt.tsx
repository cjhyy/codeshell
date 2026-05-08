/**
 * AskUserPrompt — text-input dialog for the AskUserQuestion tool.
 *
 * Rendered when the agent invokes AskUserQuestion. Pins to the bottom of
 * the layout (replacing the normal command input) and routes the user's
 * answer back through the approval channel as `{ approved: true, answer }`.
 *
 * Esc cancels (returns "(user declined to answer)" to the agent).
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../ink/index.js";
import TextInput from "./TextInput.js";

interface AskUserPromptProps {
  question: string;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}

export function AskUserPrompt({ question, onAnswer, onCancel }: AskUserPromptProps) {
  const [value, setValue] = useState("");

  useInput((_ch, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" marginLeft={1} marginY={0}>
      <Box>
        <Text color="ansi:yellow" bold>{"? "}</Text>
        <Text bold>Agent question</Text>
      </Box>
      <Box marginLeft={2} marginY={0}>
        <Text>{question}</Text>
      </Box>
      <Box marginLeft={2} marginTop={0}>
        <Text dim>{"› "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v) => onAnswer(v)}
          placeholder="type your answer, Enter to send, Esc to skip"
        />
      </Box>
    </Box>
  );
}
