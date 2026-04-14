/**
 * Task list display component.
 */
import React from "react";
import { Box, Text } from "../../ink/index.js";
import { Spinner } from "./Spinner.js";
import type { TaskInfo } from "../../types.js";

interface TaskListProps {
  tasks: TaskInfo[];
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Text bold color="ansi:cyan">Tasks</Text>
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} />
      ))}
    </Box>
  );
}

function TaskItem({ task }: { task: TaskInfo }) {
  switch (task.status) {
    case "completed":
      return (
        <Box marginLeft={2}>
          <Text color="ansi:green">{"✓ "}</Text>
          <Text strikethrough dim>{task.subject}</Text>
        </Box>
      );
    case "in_progress":
      return (
        <Box marginLeft={2}>
          <Spinner label={task.activeForm ?? task.subject} />
        </Box>
      );
    case "stopped":
      return (
        <Box marginLeft={2}>
          <Text color="ansi:red">{"✗ "}</Text>
          <Text strikethrough dim>{task.subject}</Text>
        </Box>
      );
    default:
      return (
        <Box marginLeft={2}>
          <Text dim>{"○ "}</Text>
          <Text dim>{task.subject}</Text>
        </Box>
      );
  }
}
