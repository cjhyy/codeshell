import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../render/index.js";
import {
  asyncAgentRegistry,
  type AsyncAgentEntry,
} from "../../tool-system/builtin/agent-registry.js";

export const MAX_VISIBLE = 5;
const NAME_MAX = 40;

export type DockViewMode =
  | { kind: "main" }
  | { kind: "agent"; agentId: string };

export interface AgentDockProps {
  viewMode: DockViewMode;
  /** null = dock is not the keyboard target; integer = focused row index. */
  focusedIndex: number | null;
}

/**
 * AgentDock — vertical list of running and recently-finished sub-agents,
 * pinned at the very bottom of the UI. Updates elapsed text once per
 * second; redraws are local to this subtree (no app-wide re-render).
 *
 * See docs/superpowers/specs/2026-05-18-subagent-dock-revisions-design.md.
 */
export function AgentDock({
  viewMode,
  focusedIndex,
}: AgentDockProps): React.ReactElement | null {
  const agents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );

  const [, tick] = useState(0);
  const now = Date.now();
  const visible = getVisibleAgents(agents, now);

  // 1 Hz tick — refreshes elapsed text for running rows and re-evaluates
  // the fade window so completed/failed rows drop out after 30 s.
  useEffect(() => {
    if (visible.length === 0) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [visible.length === 0]);

  if (visible.length === 0) return null;

  const rows = visible.slice(0, MAX_VISIBLE);
  const overflow = visible.length - rows.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dim>agents</Text>
      <MainDockRow
        focused={focusedIndex === 0}
        active={viewMode.kind === "main"}
      />
      {rows.map((a, i) => (
        <AgentDockRow
          key={a.agentId}
          entry={a}
          focused={focusedIndex === i + 1}
          active={viewMode.kind === "agent" && viewMode.agentId === a.agentId}
          now={now}
        />
      ))}
      {overflow > 0 && <Text dim>{`... +${overflow} more`}</Text>}
    </Box>
  );
}

function AgentDockRow({
  entry,
  focused,
  active,
  now,
}: {
  entry: AsyncAgentEntry;
  focused: boolean;
  active: boolean;
  now: number;
}) {
  const cursor = focused ? ">" : " ";
  const dotColor =
    entry.status === "running"
      ? "ansi:cyan"
      : entry.status === "completed"
        ? "ansi:green"
        : entry.status === "cancelled"
          ? "ansi:yellow"
          : "ansi:red"; /* failed */
  const elapsed = formatElapsed(
    (entry.finishedAt ?? now) - entry.startedAt,
  );
  const description = truncate(entry.description, NAME_MAX);

  return (
    // marginTop=1 visually separates rows so a list of agents reads as
    // distinct items rather than a wall of text. The first row inherits
    // the dock container's own marginTop, so this only adds gaps BETWEEN
    // rows in practice.
    <Box flexDirection="row" marginTop={1}>
      <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
        {cursor}
      </Text>
      <Text color={dotColor}>{" ● "}</Text>
      {entry.name && (
        <Text
          color={focused ? "ansi:cyanBright" : active ? "ansi:cyan" : undefined}
          bold={focused}
        >
          {entry.name + "  "}
        </Text>
      )}
      <Text
        color={focused ? "ansi:cyanBright" : active ? "ansi:cyan" : undefined}
        bold={focused}
        dim={!focused && !active && !!entry.name}
      >
        {description}
      </Text>
      <Box flexGrow={1} />
      <Text dim>{elapsed}</Text>
    </Box>
  );
}

function MainDockRow({
  focused,
  active,
}: {
  focused: boolean;
  active: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Text color={focused ? "ansi:cyanBright" : undefined} bold={focused}>
        {focused ? ">" : " "}
      </Text>
      <Text color="ansi:magenta">{" ◆ "}</Text>
      <Text
        color={focused ? "ansi:cyanBright" : active ? "ansi:magenta" : undefined}
        bold={focused}
      >
        main
      </Text>
      {focused && (
        <>
          <Box flexGrow={1} />
          <Text dim>↑/↓ to select · Enter to view</Text>
        </>
      )}
    </Box>
  );
}

/**
 * Filter the registry snapshot down to rows the dock should show:
 * running agents + recently-finished agents still inside the fade window.
 * Successful completions are dropped immediately — their final text already
 * surfaced via agent_end in the main feed, so the dock row is redundant.
 * Failures and cancellations linger so the user can investigate.
 *
 * Exported so App.tsx's keyboard handler shares the same predicate.
 */
export function getVisibleAgents(
  all: AsyncAgentEntry[],
  now: number,
): AsyncAgentEntry[] {
  return all
    .filter((a) => {
      if (a.status === "running") return true;
      if (a.status === "completed") return false;
      return a.finishedFadeAt !== undefined && now < a.finishedFadeAt;
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Format an elapsed-millisecond duration as "23s" / "4m 23s" / "1h 4m 23s".
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s}s`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
