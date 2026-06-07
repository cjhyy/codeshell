/**
 * Agent result summary — a post-pass over the folded stream that groups a run
 * of ≥2 adjacent sub-agent cards into one collapsible summary (N agents · ✓X
 * ✗Y · tools · wall-clock). Pure (no React/DOM) so the grouping + stats are
 * unit-testable; AgentGroupCard is the rendering shell.
 *
 * Runs AFTER buildStreamItems + reconcileStreamItems so it reads the latest
 * AgentMessage references and never caches — a live agent's stats stay fresh on
 * each 50ms rebuild. A single agent is left as a plain `agent` item (a summary
 * over one card is noise).
 *
 * Sub-agents are a "hard boundary" in the level-1/2 fold (not toolish), so a
 * fan-out lands as adjacent `agent` items — at the top level, OR nested inside
 * a `turn_process_group.items` (the turn card spans to its last tool, absorbing
 * agents that ran before it). So foldAgentGroups recurses into
 * turn_process_group.items. tool_group never contains agents → no recursion.
 */

import type { AgentMessage } from "../types";
import type {
  StreamItem,
  RenderedTurnProcessGroup,
  ToolGroup,
} from "./streamGroups";
import type { Message } from "../types";

export interface AgentGroup {
  kind: "agent_group";
  /** Stable id from the first member so React keys don't churn. */
  id: string;
  agents: AgentMessage[];
}

/**
 * A stream item after the agent-group post-pass: same as StreamItem, except a
 * turn_process_group's inner items may now contain AgentGroups
 * (RenderedTurnProcessGroup). This is what the render layer consumes.
 */
export type RenderedStreamItem =
  | Exclude<StreamItem, { kind: "turn_process_group" }>
  | RenderedTurnProcessGroup;

export interface AgentGroupStats {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  toolTotal: number;
  /**
   * Wall-clock across the group: latest endedAt − earliest startedAt. This is
   * parallel-aware (not a sum of per-agent durations). 0 when any member is
   * still running — the card shows a live ticker / "运行中" instead of a stale
   * number.
   */
  wallMs: number;
}

export function summarizeAgentGroup(agents: AgentMessage[]): AgentGroupStats {
  let succeeded = 0;
  let failed = 0;
  let running = 0;
  let toolTotal = 0;
  let minStart = Infinity;
  let maxEnd = 0;
  let anyRunning = false;

  for (const a of agents) {
    toolTotal += a.toolCount;
    if (a.error) failed++;
    else if (a.done) succeeded++;
    else {
      running++;
      anyRunning = true;
    }
    if (a.startedAt < minStart) minStart = a.startedAt;
    if (a.endedAt && a.endedAt > maxEnd) maxEnd = a.endedAt;
  }

  const wallMs =
    anyRunning || minStart === Infinity || maxEnd <= minStart ? 0 : maxEnd - minStart;

  return { total: agents.length, succeeded, failed, running, toolTotal, wallMs };
}

/** Is this item a sub-agent card? */
function isAgent(item: { kind: string }): item is AgentMessage {
  return item.kind === "agent";
}

/**
 * Wrap runs of ≥2 adjacent `agent` items into AgentGroups; recurse into
 * turn_process_group.items so agents nested in a turn card group too. Anything
 * else passes through untouched. A lone agent stays a plain `agent` item.
 *
 * Accepts both the canonical StreamItem[] (top-level) and the narrower inner
 * item arrays of a turn group; returns RenderedStreamItem[] (turn groups may
 * now carry AgentGroups in their items).
 */
export function foldAgentGroups(
  items: ReadonlyArray<StreamItem | RenderedStreamItem>,
): RenderedStreamItem[] {
  const out: RenderedStreamItem[] = [];
  let run: AgentMessage[] = [];

  const flush = (): void => {
    if (run.length >= 2) {
      out.push({ kind: "agent_group", id: `ag-${run[0]!.id}`, agents: run });
    } else {
      // 0 or 1 — emit as-is (a single agent is not summarized).
      for (const a of run) out.push(a);
    }
    run = [];
  };

  for (const item of items) {
    if (isAgent(item)) {
      run.push(item);
      continue;
    }
    flush();
    if (item.kind === "turn_process_group") {
      // Recurse: the turn card may hold its own agent fan-out.
      out.push({
        ...item,
        items: foldAgentGroups(item.items) as Array<Message | ToolGroup | AgentGroup>,
      });
    } else {
      out.push(item as RenderedStreamItem);
    }
  }
  flush();
  return out;
}
