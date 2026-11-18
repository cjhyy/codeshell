/**
 * The durable part of Mimi's world, sent through the context ledger.
 *
 * The host passes these lists in profileParams.ledgerContext (a JSON object).
 * Each list becomes its own ledger section keyed `capability-mimi-<list>`, so
 * a turn sends only the entries that were added, replaced or removed instead
 * of the whole world. Per-turn facts (message source, this turn's
 * capabilities, wake events, receipts) stay in the per-turn runtime context.
 */
import type {
  CapabilityDynamicContextProvider,
  CapabilityDynamicContextSection,
} from "@cjhyy/code-shell-core/extension";

type CapabilityDynamicContext = Parameters<CapabilityDynamicContextProvider>[0];

/** List keys the host moves out of the per-turn world, in section order. */
export const MIMI_LEDGER_LISTS = [
  "workspaces",
  "reusableSessions",
  "outboundTargets",
  "sessions",
  "pending",
  "followUps",
  "longTasks",
  "taskInbox",
] as const;

export type MimiLedgerList = (typeof MIMI_LEDGER_LISTS)[number];

/** Bound on the JSON the host may pass; the per-turn world has its own cap. */
export const MAX_MIMI_LEDGER_CONTEXT_LENGTH = 131_072;

const TITLES: Record<MimiLedgerList, string> = {
  workspaces: "Workspaces you may delegate work to (copy workspace_id exactly)",
  reusableSessions:
    "Reusable Work Sessions, each with its Workspace (candidates only; being listed is not a reason to reuse)",
  outboundTargets: "Owner destinations for SendMessage (copy target_id exactly)",
  sessions: "Recent Work Sessions",
  pending: "Decisions waiting for the owner",
  followUps: "Follow-ups",
  longTasks: "Long-running tasks",
  taskInbox: "Task inbox",
};

const ID_FIELDS = ["id", "sessionId", "taskId", "ruleId", "ref"] as const;

let lastInput: string | undefined;
let lastParsed: Record<string, unknown> | undefined;

function parseLedgerContext(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.length > MAX_MIMI_LEDGER_CONTEXT_LENGTH) return undefined;
  if (value === lastInput) return lastParsed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  lastInput = value;
  lastParsed =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  return lastParsed;
}

function entryId(entry: unknown, row: string): string {
  if (entry && typeof entry === "object") {
    for (const field of ID_FIELDS) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value === "string" && value) return value;
    }
  }
  // An entry without an id is identified by its content; a change replaces it.
  return `row:${row}`;
}

function sectionKey(list: MimiLedgerList): string {
  return `mimi-${list.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function sectionFor(list: MimiLedgerList, value: unknown): CapabilityDynamicContextSection {
  const key = sectionKey(list);
  const title = `${TITLES[list]} [${list}]`;
  if (!Array.isArray(value)) {
    return { key, text: `${title}:\n${JSON.stringify(value).replace(/</g, "\\u003c")}` };
  }
  const seen = new Set<string>();
  const items: { id: string; text: string }[] = [];
  for (const entry of value) {
    // Same escaping as the per-turn world: host text never opens a tag.
    const row = JSON.stringify(entry).replace(/</g, "\\u003c");
    const id = entryId(entry, row);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text: row });
  }
  return {
    key,
    header: `${title}:\n`,
    items,
    footer: items.length === 0 ? "(none)" : "",
  };
}

function isMimiTurn(context: CapabilityDynamicContext): boolean {
  return context.session?.profileId === "pet" && context.session.isSubAgent !== true;
}

/**
 * One provider per list, so each list is its own ledger section. A turn
 * without the lists (an internal turn before any chat turn since the host
 * started) leaves every list as Mimi was last told; a list missing from lists
 * the host did send is gone.
 */
export function mimiWorldLedgerProviders(): CapabilityDynamicContextProvider[] {
  return MIMI_LEDGER_LISTS.map((list) => (context: CapabilityDynamicContext) => {
    if (!isMimiTurn(context)) return undefined;
    const world = parseLedgerContext(context.runParams?.ledgerContext);
    if (!world) return { key: sectionKey(list), unchanged: true };
    if (!Object.prototype.hasOwnProperty.call(world, list)) return undefined;
    return sectionFor(list, world[list]);
  });
}
