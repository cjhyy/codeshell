/**
 * Context ledger — decides what dynamic context a run must send so that the
 * context already in history stays byte-identical (and therefore cacheable).
 *
 * The first run of a cache cycle sends a full snapshot. Later runs send only
 * what changed since the model was last told: item-level for list sections,
 * whole-section otherwise, and nothing when nothing changed.
 *
 * Pure: no I/O, no clock, no engine imports. Same input → same bytes.
 */

import { createHash } from "node:crypto";

/** One stable line/entry of a list-shaped section. */
export interface ContextSectionItem {
  id: string;
  text: string;
  /**
   * Layout-only line (group heading, blank separator). It is part of the
   * section text but never listed in an update: the entries carry their own
   * identity, so a heading whose count changed is not worth resending.
   */
  structural?: boolean;
}

export interface ContextSection {
  /** e.g. "skills" | "skill-gap" | "capability" | "memory" | "sources" | "goal-tool". */
  key: string;
  /** Full rendered text of the section. */
  text: string;
  /** Only for list-shaped sections: `header + items joined by "\n" + footer === text`. */
  items?: ContextSectionItem[];
  header?: string;
  footer?: string;
}

/** The header/items/footer triple a list renderer returns. */
export interface ContextListParts {
  header: string;
  items: ContextSectionItem[];
  footer: string;
}

export interface LedgerSectionState {
  digest: string;
  /** Item id → item digest, for list sections (structural lines excluded). */
  items?: Record<string, string>;
  /** Digest of the list section's header + footer. */
  frame?: string;
}

/** What the model has been told so far in this cache cycle. */
export interface LedgerState {
  version: 1;
  sections: Record<string, LedgerSectionState>;
}

export type LedgerEmission =
  | { kind: "none"; state: LedgerState }
  | { kind: "snapshot"; text: string; state: LedgerState }
  | { kind: "update"; text: string; state: LedgerState };

export const LEDGER_UPDATE_PREAMBLE =
  "Context update: the entries below supersede earlier context with the same section and id " +
  "(+ added, ~ replaced by this full text, - removed by id); anything not listed is unchanged.";

/** Rendered text of a list section; the invariant every list renderer keeps. */
export function joinContextListParts(parts: ContextListParts): string {
  return parts.header + parts.items.map((item) => item.text).join("\n") + parts.footer;
}

export function contextListSection(key: string, parts: ContextListParts): ContextSection {
  return { key, text: joinContextListParts(parts), ...parts };
}

/** Full snapshot message text, or null when there is nothing to say. */
export function renderContextSnapshot(sections: readonly ContextSection[]): string | null {
  const parts = sections.map((section) => section.text).filter(Boolean);
  if (parts.length === 0) return null;
  return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function frameDigest(section: ContextSection): string {
  return digest(JSON.stringify([section.header ?? "", section.footer ?? ""]));
}

/** Listable entries, or undefined when the section must be treated as whole text. */
function listableItems(section: ContextSection): ContextSectionItem[] | undefined {
  if (!section.items) return undefined;
  const entries = section.items.filter((item) => item.structural !== true);
  // Ambiguous ids cannot be addressed in an update; fall back to whole text.
  if (new Set(entries.map((item) => item.id)).size !== entries.length) return undefined;
  return entries;
}

function live(sections: readonly ContextSection[]): ContextSection[] {
  const seen = new Set<string>();
  return sections.filter((section) => {
    if (!section.text || seen.has(section.key)) return false;
    seen.add(section.key);
    return true;
  });
}

/** The state after the model has been told exactly these sections. */
export function ledgerStateForSections(sections: readonly ContextSection[]): LedgerState {
  return {
    version: 1,
    sections: Object.fromEntries(
      live(sections).map((section): [string, LedgerSectionState] => {
        const entries = listableItems(section);
        return [
          section.key,
          entries === undefined
            ? { digest: digest(section.text) }
            : {
                digest: digest(section.text),
                frame: frameDigest(section),
                items: Object.fromEntries(entries.map((item) => [item.id, digest(item.text)])),
              },
        ];
      }),
    ),
  };
}

function fullSection(section: ContextSection): string {
  return `<context-section key="${section.key}">\n${section.text}\n</context-section>`;
}

/** Item-level block, or undefined when the whole section should be resent. */
function itemUpdate(section: ContextSection, known: LedgerSectionState): string | undefined {
  const entries = listableItems(section);
  if (entries === undefined || known.items === undefined) return undefined;
  if (known.frame !== frameDigest(section)) return undefined;
  const current = new Set(entries.map((item) => item.id));
  const lines: string[] = [];
  for (const item of entries) {
    const before = own(known.items, item.id);
    if (before === undefined) lines.push(`+ ${item.text}`);
    else if (before !== digest(item.text)) lines.push(`~ ${item.text}`);
  }
  for (const id of Object.keys(known.items)) {
    if (!current.has(id)) lines.push(`- ${id}`);
  }
  // No entry changed (only order or layout did), or most did: resend it whole.
  if (lines.length === 0 || lines.length * 2 > entries.length) return undefined;
  return `<context-update section="${section.key}">\n${lines.join("\n")}\n</context-update>`;
}

export function planLedgerEmission(
  sections: readonly ContextSection[],
  previous: LedgerState | undefined,
): LedgerEmission {
  const current = live(sections);
  const state = ledgerStateForSections(current);
  if (previous === undefined) {
    const text = renderContextSnapshot(current);
    return text === null ? { kind: "none", state } : { kind: "snapshot", text, state };
  }

  const blocks: string[] = [];
  for (const section of current) {
    const known = own(previous.sections, section.key);
    if (known?.digest === own(state.sections, section.key)?.digest) continue;
    blocks.push((known && itemUpdate(section, known)) ?? fullSection(section));
  }
  for (const key of Object.keys(previous.sections)) {
    if (own(state.sections, key) === undefined) {
      blocks.push(`Section "${key}" no longer applies; disregard its earlier content.`);
    }
  }
  if (blocks.length === 0) return { kind: "none", state };
  return {
    kind: "update",
    text: `<system-reminder>\n${[LEDGER_UPDATE_PREAMBLE, ...blocks].join("\n\n")}\n</system-reminder>`,
    state,
  };
}

export function serializeLedgerState(state: LedgerState): string {
  return JSON.stringify(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a stored ledger state (JSON text or an already-parsed value). Unknown
 * or corrupt data yields undefined — the caller then starts a new snapshot.
 */
export function parseLedgerState(input: unknown): LedgerState | undefined {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sections)) return undefined;
  const sections: [string, LedgerSectionState][] = [];
  for (const [key, raw] of Object.entries(value.sections)) {
    if (!isRecord(raw) || typeof raw.digest !== "string") return undefined;
    const section: LedgerSectionState = { digest: raw.digest };
    if (raw.frame !== undefined) {
      if (typeof raw.frame !== "string") return undefined;
      section.frame = raw.frame;
    }
    if (raw.items !== undefined) {
      if (!isRecord(raw.items)) return undefined;
      const items = Object.entries(raw.items);
      if (!items.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
        return undefined;
      }
      section.items = Object.fromEntries(items);
    }
    sections.push([key, section]);
  }
  return { version: 1, sections: Object.fromEntries(sections) };
}
