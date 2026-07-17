import type { DigitalHumanSelection } from "./types";

export const DIGITAL_HUMAN_SELECTION_STORAGE_KEY = "codeshell.pet.digital-human-selection.v1";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LABEL_MAX = 120;
const TEAM_MEMBER_MAX = 8;

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function validLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= LABEL_MAX &&
    !/[\0\r\n]/u.test(value)
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

export function parseDigitalHumanSelection(value: unknown): DigitalHumanSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!validId(raw.id) || !validLabel(raw.label)) return null;

  if (raw.kind === "single") {
    return { kind: "single", id: raw.id, label: raw.label.trim() };
  }
  if (raw.kind !== "team" || !Array.isArray(raw.members)) return null;
  if (
    raw.members.length < 2 ||
    raw.members.length > TEAM_MEMBER_MAX ||
    !raw.members.every(validId) ||
    new Set(raw.members).size !== raw.members.length
  ) {
    return null;
  }
  if (raw.mode !== "auto" && raw.mode !== "divide" && raw.mode !== "compare") return null;
  return {
    kind: "team",
    id: raw.id,
    label: raw.label.trim(),
    members: [...raw.members],
    mode: raw.mode,
  };
}

export function parseStoredDigitalHumanSelection(raw: string | null): DigitalHumanSelection | null {
  if (raw === null) return null;
  try {
    return parseDigitalHumanSelection(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function digitalHumanSelectionsEqual(
  left: DigitalHumanSelection | null,
  right: DigitalHumanSelection | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind || left.id !== right.id) return false;
  if (left.label !== right.label) return false;
  if (left.kind === "single" || right.kind === "single") return left.kind === right.kind;
  return (
    left.mode === right.mode &&
    left.members.length === right.members.length &&
    left.members.every((member, index) => member === right.members[index])
  );
}

export function loadDigitalHumanSelection(
  storage: SelectionStorage = window.localStorage,
): DigitalHumanSelection | null {
  try {
    return parseStoredDigitalHumanSelection(storage.getItem(DIGITAL_HUMAN_SELECTION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveDigitalHumanSelection(
  selection: DigitalHumanSelection | null,
  storage: SelectionStorage = window.localStorage,
): void {
  try {
    if (selection === null) {
      storage.removeItem(DIGITAL_HUMAN_SELECTION_STORAGE_KEY);
      return;
    }
    const normalized = parseDigitalHumanSelection(selection);
    if (!normalized) {
      storage.removeItem(DIGITAL_HUMAN_SELECTION_STORAGE_KEY);
      return;
    }
    storage.setItem(DIGITAL_HUMAN_SELECTION_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Selection is a convenience preference; unavailable storage must not
    // prevent the Pet or digital-human library from opening.
  }
}
