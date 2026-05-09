/**
 * Agent block — renders sub-agent activity with CC-style tree-line nesting.
 *
 * Running:
 *   ├─ Agent description · Nk tokens
 *   │  ⎿  Running tool…
 *
 * Completed:
 *   └─ Agent description · Done
 *      ⎿  completed
 */
import React from "react";
import { Box, Text } from "../../render/index.js";
import { Spinner } from "./Spinner.js";

interface AgentBlockStartProps {
  description: string;
  running?: boolean;
  isLast?: boolean;
}

export function AgentBlockStart({ description, running, isLast }: AgentBlockStartProps) {
  const treeChar = isLast ? "└─" : "├─";
  const continueLine = isLast ? "   " : "│  ";

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Box>
        <Text dim>{treeChar} </Text>
        {running ? (
          <>
            <Spinner label="" color="ansi:cyan" />
            <Text bold> {description}</Text>
          </>
        ) : (
          <>
            <Text bold>{description}</Text>
          </>
        )}
      </Box>
      {running && (
        <Box>
          <Text dim>{continueLine}⎿ </Text>
          <Text dim>Initializing…</Text>
        </Box>
      )}
    </Box>
  );
}

interface AgentBlockEndProps {
  description: string;
  error?: string;
  isLast?: boolean;
}

export function AgentBlockEnd({ description, error, isLast }: AgentBlockEndProps) {
  const treeChar = isLast ? "└─" : "├─";
  const continueLine = isLast ? "   " : "│  ";

  if (error) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Box>
          <Text dim>{treeChar} </Text>
          <Text color="ansi:red">{description}</Text>
          <Text dim> · </Text>
          <Text color="ansi:red">Error</Text>
        </Box>
        <Box>
          <Text dim>{continueLine}⎿ </Text>
          <Text color="ansi:red">{error.slice(0, 80)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text dim>{treeChar} </Text>
        <Text>{description}</Text>
        <Text dim> · </Text>
        <Text color="ansi:green">Done</Text>
      </Box>
    </Box>
  );
}

/**
 * Tree line prefix for nested content under an agent.
 */
export function NestedPrefix({
  children,
  isLast,
}: {
  children: React.ReactNode;
  isLast?: boolean;
}) {
  const line = isLast ? "   " : "│  ";
  return (
    <Box marginLeft={1}>
      <Text dim>{line}</Text>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
