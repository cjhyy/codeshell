import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../render/index.js";
import { asyncAgentRegistry } from "../../tool-system/builtin/agent-registry.js";

const MAX_VISIBLE = 5;

/**
 * AgentDock — a bottom-bar strip showing the running `run_in_background`
 * sub-agents. Only renders when at least one agent is running. Updates the
 * elapsed-time text once per second; the local interval is scoped to this
 * component (no app-wide re-render).
 */
export function AgentDock(): React.ReactElement | null {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );
  const running = agents.filter((a) => a.status === "running");

  // Local 1 Hz tick to refresh elapsed-time text. Only runs while there is
  // at least one running agent — idle dock writes zero frames. Local
  // useState forceUpdate keeps the re-render scoped to this subtree.
  const [, tick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running.length === 0]);

  if (running.length === 0) return null;

  const visible = running.slice(0, MAX_VISIBLE);
  const overflow = running.length - visible.length;
  const now = Date.now();

  return (
    <Box flexDirection="row" gap={1} paddingX={1}>
      <Text dim>agents:</Text>
      {visible.map((a, i) => {
        const elapsedSec = Math.floor((now - a.startedAt) / 1000);
        return (
          <Text key={a.agentId} color="ansi:cyan">
            [{i + 1}] {a.description} {elapsedSec}s
          </Text>
        );
      })}
      {overflow > 0 && <Text dim>+{overflow} more</Text>}
    </Box>
  );
}
