import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text } from "../../render/index.js";
import {
  asyncAgentRegistry,
  type AsyncAgentEntry,
} from "@cjhyy/code-shell-core/internal";
import { logger as uiLogger } from "@cjhyy/code-shell-core";
import { stringWidth } from "../../render/stringWidth.js";

export const MAX_VISIBLE = 5;
const NAME_MAX = 40;
// Width of the right-aligned elapsed column. Covers "99h 59m 59s" (11
// cols) plus a safety pad. Fixed so the row's measured width is constant
// across 1Hz ticks — see AgentDockRow comment for the flicker rationale.
const ELAPSED_WIDTH = 12;

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
    uiLogger.info("flicker.dock_tick_start", {
      cat: "flicker",
      visibleCount: visible.length,
      rows: visible.map((a) => ({
        id: a.agentId,
        name: a.name,
        status: a.status,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
      })),
    });
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      uiLogger.info("flicker.dock_tick_stop", { cat: "flicker" });
      clearInterval(id);
    };
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
  // FLICKER FIX: pad elapsed to a fixed display width so the 1Hz tick
  // that walks `1s → 2s → ... → 10s → ... → 1m 0s → 1h 0m 0s` never
  // changes the row's overall length. Without this, every elapsed
  // widening triggers a Yoga layout shift on this row — which in turn
  // forces render-node-to-output's full-screen damage backstop and
  // produces a visible flicker every second for any running agent.
  // ELAPSED_WIDTH covers up to "99h 59m 59s" (11 cols) with room to
  // spare — agents lasting longer than 99h aren't a real case.
  const elapsed = padRightToWidth(
    formatElapsed((entry.finishedAt ?? now) - entry.startedAt),
    ELAPSED_WIDTH,
  );
  // Truncate AND pad description so the name column doesn't change
  // width either (long descriptions truncate, short ones pad).
  const description = padRightToWidth(
    truncate(entry.description, NAME_MAX),
    NAME_MAX,
  );

  return (
    <Box flexDirection="row" height={1} overflow="hidden">
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
      {entry.agentType && <Text dim>{`[${entry.agentType}] `}</Text>}
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

/**
 * Pad-or-truncate `s` so its terminal display width equals exactly `target`.
 * Padding is added as trailing spaces; truncation drops codepoints from
 * the end until the width fits. Stringwidth-aware so CJK characters
 * count as 2 columns, matching what the renderer measures via Yoga.
 *
 * Used by the dock to keep row widths constant across 1Hz elapsed
 * updates — see AgentDockRow flicker note.
 */
function padRightToWidth(s: string, target: number): string {
  const w = stringWidth(s);
  if (w === target) return s;
  if (w < target) return s + " ".repeat(target - w);
  const chars = Array.from(s);
  let acc = "";
  let accW = 0;
  for (const c of chars) {
    const cw = stringWidth(c);
    if (accW + cw > target) break;
    acc += c;
    accW += cw;
  }
  if (accW < target) acc += " ".repeat(target - accW);
  return acc;
}
