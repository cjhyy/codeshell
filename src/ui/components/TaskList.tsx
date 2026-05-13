/**
 * Task list display component.
 */
import React from "react";
import { Box, Text } from "../../render/index.js";
import { Spinner } from "./Spinner.js";
import type { TaskInfo } from "../../types.js";

interface TaskListProps {
  tasks: TaskInfo[];
}

export function TaskList({ tasks }: TaskListProps) {
  if (tasks.length === 0) return null;

  // Single task: skip the "Tasks" header and indented block — the lone
  // row reads cleaner inline. Multi-task keeps the header for grouping.
  if (tasks.length === 1) {
    return (
      <Box marginLeft={1} marginTop={1}>
        <TaskItem task={tasks[0]!} indent={false} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1} marginTop={1}>
      <Text bold color="ansi:cyan">Tasks</Text>
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} indent />
      ))}
    </Box>
  );
}

function TaskItem({ task, indent = true }: { task: TaskInfo; indent?: boolean }) {
  const ml = indent ? 2 : 0;
  switch (task.status) {
    case "completed":
      return (
        <Box marginLeft={ml}>
          <Text color="ansi:green">{"✓ "}</Text>
          <Text strikethrough dim>{task.subject}</Text>
        </Box>
      );
    case "in_progress":
      return (
        <Box marginLeft={ml}>
          <Spinner label={task.activeForm ?? task.subject} />
        </Box>
      );
    case "stopped":
      return (
        <Box marginLeft={ml}>
          <Text color="ansi:red">{"✗ "}</Text>
          <Text strikethrough dim>{task.subject}</Text>
        </Box>
      );
    default:
      return (
        <Box marginLeft={ml}>
          <Text dim>{"○ "}</Text>
          <Text dim>{task.subject}</Text>
        </Box>
      );
  }
}
