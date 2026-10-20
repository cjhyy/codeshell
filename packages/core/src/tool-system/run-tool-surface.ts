import type { SessionToolSelection, ToolDefinition } from "../types.js";

/** Persisted loading hints are bounded data, never proof of tool eligibility. */
export function normalizeSessionToolSelection(value: unknown): SessionToolSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { version, names } = value as SessionToolSelection;
  if (
    version !== 1 ||
    !Array.isArray(names) ||
    names.length > 4096 ||
    names.some(
      (name) =>
        typeof name !== "string" ||
        !name ||
        name.length > 512 ||
        name.trim() !== name ||
        /[\u0000-\u001f\u007f]/u.test(name),
    )
  )
    return undefined;
  return { version: 1, names: [...new Set(names)] };
}

/** Eligible tool definitions and schema loading state owned by one Engine run. */
export class RunToolSurface {
  private readonly initialToolNames: readonly string[] | undefined;
  private readonly selectedNames = new Set<string>();
  private catalog: readonly ToolDefinition[] = Object.freeze([]);
  private catalogByName = new Map<string, ToolDefinition>();
  private readonly onSelectionChanged?: (selection: SessionToolSelection) => void;

  constructor(
    initialToolNames?: readonly string[],
    options: {
      selection?: unknown;
      onSelectionChanged?: (selection: SessionToolSelection) => void;
    } = {},
  ) {
    this.initialToolNames = initialToolNames ? [...initialToolNames] : undefined;
    for (const name of normalizeSessionToolSelection(options.selection)?.names ?? []) {
      this.selectedNames.add(name);
    }
    this.onSelectionChanged = options.onSelectionChanged;
  }

  /** Replace eligibility with the run's latest authorized, rewritten definitions. */
  updateCatalog(definitions: readonly ToolDefinition[]): void {
    const previousSize = this.selectedNames.size;
    const byName = new Map<string, ToolDefinition>();
    for (const definition of definitions) {
      byName.set(definition.name, cloneFrozen(definition));
    }
    this.catalogByName = byName;
    this.catalog = Object.freeze([...byName.values()]);

    const initialNames = this.initialToolNames ?? [...byName.keys()];
    for (const name of initialNames) {
      if (byName.has(name)) this.selectedNames.add(name);
    }
    // Discovery remains available even when the explicit initial surface is empty.
    if (byName.has("ToolSearch")) this.selectedNames.add("ToolSearch");
    else {
      // A host without discovery must keep its eligible tools reachable. If
      // ToolSearch returns later, these schemas retain their run-local load order.
      for (const name of byName.keys()) this.selectedNames.add(name);
    }
    if (this.selectedNames.size !== previousSize) this.onSelectionChanged?.(this.getSelection());
  }

  getCatalog(): readonly ToolDefinition[] {
    return this.catalog;
  }

  select(names: readonly string[]): { selected: string[]; unavailable: string[] } {
    const previousSize = this.selectedNames.size;
    const selected: string[] = [];
    const unavailable: string[] = [];
    for (const name of new Set(names)) {
      if (this.isEligible(name)) {
        this.selectedNames.add(name);
        selected.push(name);
      } else {
        unavailable.push(name);
      }
    }
    if (this.selectedNames.size !== previousSize) this.onSelectionChanged?.(this.getSelection());
    return { selected, unavailable };
  }

  /** Include temporarily unavailable names so restoration retains the original order. */
  getSelection(): SessionToolSelection {
    return { version: 1, names: [...this.selectedNames] };
  }

  /** A provider receives an immutable copy, never the live catalog or loading state. */
  snapshot(): ToolDefinition[] {
    const definitions: ToolDefinition[] = [];
    for (const name of this.selectedNames) {
      const definition = this.catalogByName.get(name);
      if (definition) definitions.push(cloneFrozen(definition));
    }
    return Object.freeze(definitions) as unknown as ToolDefinition[];
  }

  isSelected(name: string): boolean {
    return this.isEligible(name) && this.selectedNames.has(name);
  }

  isEligible(name: string): boolean {
    return this.catalogByName.has(name);
  }
}

function cloneFrozen<T>(value: T): T {
  const clone = structuredClone(value);
  const visited = new WeakSet<object>();
  const freeze = (entry: unknown): void => {
    if (!entry || typeof entry !== "object" || visited.has(entry)) return;
    visited.add(entry);
    for (const key of Reflect.ownKeys(entry)) freeze(Reflect.get(entry, key));
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}
