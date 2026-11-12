/**
 * Context ledger — decides what dynamic context a run must send so that the
 * context already in history stays byte-identical (and therefore cacheable).
 *
 * The first run of a cache cycle sends a full snapshot. Later runs send only
 * what changed since the model was last told: item-level for list sections,
 * whole-section otherwise, and nothing when nothing changed.
 *
 * Every section is sent inside a tag that names it, and an update refers to
 * sections and entries only by what the model was shown:
 *
 *   <system-reminder>
 *   <context-section key="memory">
 *   # Persistent Memory (index)
 *
 *   - [scope="user" location="project" type="user"] build: use bun, not npm
 *   - [scope="user" location="project" type="user"] style: no default exports
 *   </context-section>
 *
 *   <context-section key="goal-tool">
 *   Goal state: none.
 *   </context-section>
 *   </system-reminder>
 *
 * and later, when one memory was added, one removed and the goal went away:
 *
 *   <system-reminder>
 *   Context update: …
 *
 *   <context-update section="memory">
 *   Added:
 *   - [scope="user" location="project" type="user"] tests: run the guarded runner
 *   Removed: "style"
 *   </context-update>
 *
 *   <context-section-removed key="goal-tool" />
 *   </system-reminder>
 *
 * Pure: no I/O, no clock, no engine imports. Same input → same bytes.
 */

import { createHash } from "node:crypto";

/** One stable line/entry of a list-shaped section. */
export interface ContextSectionItem {
  id: string;
  /** The entry's row. Sent as a single line: line breaks become spaces. */
  text: string;
  /**
   * The entry's name as `text` shows it; quoted when the entry is removed, so
   * a removal never cites an identifier the model has not seen. Defaults to
   * `id`.
   */
  label?: string;
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
  /**
   * "ids": the listing is a ranked/budgeted view whose row texts and visible
   * rows vary between runs without anything being installed or removed. Such
   * a section is compared by entry id only: an update lists added and removed
   * entries, and a row whose id persists is never resent. Such a section is
   * kept while `knownIds` is non-empty even when its text is empty (nothing
   * fitted the budget): the entries still exist, so it is not announced as
   * removed.
   */
  compare?: "ids";
  /**
   * With `compare: "ids"`: every id that exists, shown in `items` or not.
   * Defaults to the ids of the listable items.
   */
  knownIds?: readonly string[];
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
  /** Item id → the name the model was shown, where that differs from the id. */
  labels?: Record<string, string>;
}

/** What the model has been told so far in this cache cycle. */
export interface LedgerState {
  /** 2: sections are tagged in the snapshot. Older states start a new snapshot. */
  version: 2;
  sections: Record<string, LedgerSectionState>;
  /**
   * The workspace the chain was emitted for (root and project). Context told
   * for another workspace must not stay visible: see run-context-ledger.ts.
   * Absent in states written before it was recorded: unknown.
   */
  scope?: string;
}

export type LedgerEmission =
  | { kind: "none"; state: LedgerState }
  | { kind: "snapshot"; text: string; state: LedgerState }
  | { kind: "update"; text: string; state: LedgerState };

export const LEDGER_UPDATE_PREAMBLE =
  "Context update: each block below changes the earlier <context-section> with the same key. " +
  'In a <context-update>, entries under "Added:" are new, entries under "Replaced:" ' +
  'supersede the earlier entry of the same name, and a "Removed:" line names an entry that ' +
  "no longer exists. A <context-section> block replaces that whole section and a " +
  "<context-section-removed> tag withdraws it. Anything not mentioned is unchanged.";

/** frame value of an id-compared section whose listing was not shown. */
const UNLISTED = "unlisted";

/** Rendered text of a list section; the invariant every list renderer keeps. */
export function joinContextListParts(parts: ContextListParts): string {
  return parts.header + parts.items.map((item) => item.text).join("\n") + parts.footer;
}

export function contextListSection(key: string, parts: ContextListParts): ContextSection {
  return { key, text: joinContextListParts(parts), ...parts };
}

/** Full snapshot message text, or null when there is nothing to say. */
export function renderContextSnapshot(sections: readonly ContextSection[]): string | null {
  const parts = live(sections)
    .filter((section) => Boolean(section.text))
    .map(fullSection);
  if (parts.length === 0) return null;
  return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;
}

/**
 * Entries are line-based: a line break inside one (a multi-line memory
 * description, say) would read as further rows, or as a line of an update.
 */
function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/**
 * The tags that frame ledger output. An opening or closing one inside section
 * content (a memory description, a skill summary, a file name) would end the
 * block early or start a forged one, so its `<` is written as `&lt;`. The
 * escape is deterministic and leaves text without such a tag untouched.
 */
const LEDGER_DELIMITER_TAG = /<(\/?)(context-section|context-update|system-reminder)/gi;

export function escapeLedgerDelimiters(text: string): string {
  return text.includes("<") ? text.replace(LEDGER_DELIMITER_TAG, "&lt;$1$2") : text;
}

/**
 * Section content made safe to frame: list entries on one line, ledger tags
 * escaped everywhere. A section without either is returned unchanged.
 */
function normalized(section: ContextSection): ContextSection {
  if (!section.items) {
    const text = escapeLedgerDelimiters(section.text);
    return text === section.text ? section : { ...section, text };
  }
  const items = section.items.map((item) => ({
    ...item,
    text: escapeLedgerDelimiters(singleLine(item.text)),
    ...(item.label === undefined ? {} : { label: escapeLedgerDelimiters(singleLine(item.label)) }),
  }));
  const header = escapeLedgerDelimiters(section.header ?? "");
  const footer = escapeLedgerDelimiters(section.footer ?? "");
  if (
    header === (section.header ?? "") &&
    footer === (section.footer ?? "") &&
    items.every((item, index) => item.text === section.items![index]!.text)
  ) {
    return { ...section, items };
  }
  return {
    ...section,
    items,
    ...(section.header === undefined ? {} : { header }),
    ...(section.footer === undefined ? {} : { footer }),
    text: joinContextListParts({ header, items, footer }),
  };
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

/** Sorted id universe of an id-compared section, or undefined otherwise. */
function comparedIds(section: ContextSection): string[] | undefined {
  if (section.compare !== "ids") return undefined;
  const ids = section.knownIds ?? listableItems(section)?.map((item) => item.id);
  return ids === undefined ? undefined : [...new Set(ids)].sort();
}

/** True for an id-compared section whose entries exist but whose listing is empty. */
function unlisted(section: ContextSection): boolean {
  return !section.text && section.compare === "ids" && (section.knownIds?.length ?? 0) > 0;
}

function live(sections: readonly ContextSection[]): ContextSection[] {
  const seen = new Set<string>();
  return sections
    .filter((section) => {
      if ((!section.text && !unlisted(section)) || seen.has(section.key)) return false;
      seen.add(section.key);
      return true;
    })
    .map(normalized);
}

/** Names of the listable entries whose name differs from their id. */
function labelsOf(entries: readonly ContextSectionItem[] | undefined): {
  labels?: Record<string, string>;
} {
  const named = (entries ?? []).filter(
    (item) => item.label !== undefined && item.label !== item.id,
  );
  return named.length === 0
    ? {}
    : { labels: Object.fromEntries(named.map((item) => [item.id, item.label!])) };
}

/** The state after the model has been told exactly these sections. */
export function ledgerStateForSections(sections: readonly ContextSection[]): LedgerState {
  return {
    version: 2,
    sections: Object.fromEntries(
      live(sections).map((section): [string, LedgerSectionState] => {
        const ids = comparedIds(section);
        if (ids !== undefined) {
          // Identity only: the same ids are the same state whatever the text.
          // Whether the listing was shown is part of it, so the listing is
          // sent once it fits.
          const hidden = unlisted(section);
          return [
            section.key,
            {
              digest: digest(JSON.stringify(hidden ? [ids, UNLISTED] : ids)),
              items: Object.fromEntries(ids.map((id) => [id, ""])),
              ...(hidden ? { frame: UNLISTED } : {}),
              ...labelsOf(listableItems(section)),
            },
          ];
        }
        const entries = listableItems(section);
        return [
          section.key,
          entries === undefined
            ? { digest: digest(section.text) }
            : {
                digest: digest(section.text),
                frame: frameDigest(section),
                items: Object.fromEntries(entries.map((item) => [item.id, digest(item.text)])),
                ...labelsOf(entries),
              },
        ];
      }),
    ),
  };
}

function fullSection(section: ContextSection): string {
  return `<context-section key="${section.key}">\n${section.text}\n</context-section>`;
}

interface ItemChanges {
  /** Rows of new entries. */
  added: string[];
  /** Full new rows of entries whose text changed. */
  replaced: string[];
  /** Names (as shown) of entries that no longer exist. */
  removed: string[];
}

function changeCount(changes: ItemChanges): number {
  return changes.added.length + changes.replaced.length + changes.removed.length;
}

function updateBlock(section: ContextSection, changes: ItemChanges): string {
  const lines = [
    ...(changes.added.length > 0 ? ["Added:", ...changes.added] : []),
    ...(changes.replaced.length > 0 ? ["Replaced:", ...changes.replaced] : []),
    // Quoted and labelled, so a removal cannot be mistaken for a list row.
    ...changes.removed.map((name) => `Removed: ${JSON.stringify(name)}`),
  ];
  return `<context-update section="${section.key}">\n${lines.join("\n")}\n</context-update>`;
}

/** The name the model was shown for a stored entry id. */
function shownName(known: LedgerSectionState, id: string): string {
  return (known.labels && own(known.labels, id)) ?? escapeLedgerDelimiters(id);
}

/** Ids the model was told about that no longer exist, by shown name. */
function removedNames(known: LedgerSectionState, current: ReadonlySet<string>): string[] {
  return Object.keys(known.items ?? {})
    .filter((id) => !current.has(id))
    .map((id) => shownName(known, id));
}

/**
 * Added/removed entries of an id-compared section. Undefined to resend the
 * section whole, null when there is nothing to tell.
 */
function idUpdate(section: ContextSection, known: LedgerSectionState): string | null | undefined {
  const ids = comparedIds(section);
  if (ids === undefined || known.items === undefined) return undefined;
  // The listing was never shown in this cycle and now fits: send it.
  if (known.frame === UNLISTED && section.text) return undefined;
  const shown = new Map(listableItems(section)?.map((item) => [item.id, item.text]));
  const changes: ItemChanges = {
    // An entry outside the visible listing has no row; its name stands alone.
    added: ids
      .filter((id) => own(known.items!, id) === undefined)
      .map((id) => shown.get(id) ?? escapeLedgerDelimiters(singleLine(id))),
    replaced: [],
    removed: removedNames(known, new Set(ids)),
  };
  if (changeCount(changes) > 0) return updateBlock(section, changes);
  // Same entries: only whether the listing is shown differs. A listing that
  // no longer fits takes nothing back from what the model was told.
  return section.text ? undefined : null;
}

/**
 * Item-level block. Undefined when the whole section should be resent, null
 * when there is nothing to tell.
 */
function itemUpdate(section: ContextSection, known: LedgerSectionState): string | null | undefined {
  if (section.compare === "ids") return idUpdate(section, known);
  const entries = listableItems(section);
  if (entries === undefined || known.items === undefined) return undefined;
  if (known.frame !== frameDigest(section)) return undefined;
  const changes: ItemChanges = {
    added: [],
    replaced: [],
    removed: removedNames(known, new Set(entries.map((item) => item.id))),
  };
  for (const item of entries) {
    const before = own(known.items, item.id);
    if (before === undefined) changes.added.push(item.text);
    else if (before !== digest(item.text)) changes.replaced.push(item.text);
  }
  // No entry changed (only order or layout did), or most did: resend it whole.
  const count = changeCount(changes);
  if (count === 0 || count * 2 > entries.length) return undefined;
  return updateBlock(section, changes);
}

/** What to say about a section whose state differs from what the model was told. */
function sectionUpdate(
  section: ContextSection,
  known: LedgerSectionState | undefined,
): string | null {
  const block = known ? itemUpdate(section, known) : undefined;
  if (block !== undefined) return block;
  // An unlisted section has no text to send; its entries are only recorded.
  return section.text ? fullSection(section) : null;
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
    const block = sectionUpdate(section, known);
    if (block !== null) blocks.push(block);
  }
  for (const key of Object.keys(previous.sections)) {
    if (own(state.sections, key) === undefined) {
      blocks.push(`<context-section-removed key="${key}" />`);
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
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.sections)) return undefined;
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
    if (raw.labels !== undefined) {
      if (!isRecord(raw.labels)) return undefined;
      const labels = Object.entries(raw.labels);
      if (!labels.every((entry): entry is [string, string] => typeof entry[1] === "string")) {
        return undefined;
      }
      section.labels = Object.fromEntries(labels);
    }
    sections.push([key, section]);
  }
  return {
    version: 2,
    sections: Object.fromEntries(sections),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
  };
}
