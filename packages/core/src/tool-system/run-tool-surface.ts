import type { ToolDefinition } from "../types.js";

/** Eligible tool definitions and schema loading state owned by one Engine run. */
export class RunToolSurface {
  private readonly initialToolNames: readonly string[] | undefined;
  private readonly selectedNames = new Set<string>();
  private catalog: readonly ToolDefinition[] = Object.freeze([]);
  private catalogByName = new Map<string, ToolDefinition>();

  constructor(initialToolNames?: readonly string[]) {
    this.initialToolNames = initialToolNames ? [...initialToolNames] : undefined;
  }

  /** Replace eligibility with the run's latest authorized, rewritten definitions. */
  updateCatalog(definitions: readonly ToolDefinition[]): void {
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
  }

  getCatalog(): readonly ToolDefinition[] {
    return this.catalog;
  }

  select(names: readonly string[]): { selected: string[]; unavailable: string[] } {
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
    return { selected, unavailable };
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
