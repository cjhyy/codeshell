import type { SessionToolSelection, ToolDefinition } from "../types.js";

const MAX_NAMES = 4096;
const MAX_FROZEN_DEFINITIONS_BYTES = 16 * 1024 * 1024;
const EMPTY_NAMES: readonly string[] = Object.freeze([]);

function validNames(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_NAMES &&
    value.every(
      (name) =>
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= 512 &&
        name.trim() === name &&
        !/[\u0000-\u001f\u007f]/u.test(name),
    )
  );
}

/** Persisted cache hints and schemas never establish current tool eligibility. */
export function normalizeSessionToolSelection(value: unknown): SessionToolSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const {
      version,
      names,
      discovered,
      frozenDefinitions,
      deferredDefinitions,
      behaviorToolNames,
      cacheIdentity,
      cacheVersion,
      lastRequestAt,
    } = value as Record<string, unknown>;
    if ((version !== 1 && version !== 2) || !validNames(names)) return undefined;
    if (version === 2 && !validNames(discovered)) return undefined;
    if (behaviorToolNames !== undefined && !validNames(behaviorToolNames)) return undefined;
    if (
      cacheVersion !== undefined &&
      (typeof cacheVersion !== "string" || cacheVersion.length === 0 || cacheVersion.length > 256)
    )
      return undefined;
    if (lastRequestAt !== undefined && !validRequestTime(lastRequestAt)) return undefined;
    const selection: SessionToolSelection = {
      version: 2,
      names: [...new Set(names)],
      discovered: version === 2 ? [...new Set(discovered as string[])] : [],
      ...(behaviorToolNames !== undefined
        ? { behaviorToolNames: [...new Set(behaviorToolNames as string[])] }
        : {}),
      ...(typeof cacheIdentity === "string" && cacheIdentity.length <= 4096
        ? { cacheIdentity }
        : {}),
      ...(cacheVersion !== undefined ? { cacheVersion: cacheVersion as string } : {}),
      ...(lastRequestAt !== undefined ? { lastRequestAt: lastRequestAt as number } : {}),
    };
    if (version === 2 && frozenDefinitions !== undefined) {
      if (
        !Array.isArray(frozenDefinitions) ||
        frozenDefinitions.length > MAX_NAMES ||
        frozenDefinitions.some(
          (definition) =>
            !definition ||
            typeof definition !== "object" ||
            !selection.names.includes(definition.name) ||
            typeof definition.description !== "string" ||
            !definition.inputSchema ||
            typeof definition.inputSchema !== "object" ||
            Array.isArray(definition.inputSchema),
        ) ||
        new Set(frozenDefinitions.map((definition) => definition.name)).size !==
          frozenDefinitions.length ||
        Buffer.byteLength(JSON.stringify(frozenDefinitions)) > MAX_FROZEN_DEFINITIONS_BYTES
      )
        return undefined;
      // JSON serialization preserves schema key order and rejects circular state.
      selection.frozenDefinitions = JSON.parse(JSON.stringify(frozenDefinitions));
    }
    if (version === 2 && deferredDefinitions !== undefined) {
      if (
        !Array.isArray(deferredDefinitions) ||
        !validNames(deferredDefinitions.map((definition) => definition?.name)) ||
        deferredDefinitions.some(
          (definition) =>
            !definition ||
            typeof definition !== "object" ||
            selection.names.includes(definition.name) ||
            typeof definition.description !== "string" ||
            !definition.inputSchema ||
            typeof definition.inputSchema !== "object" ||
            Array.isArray(definition.inputSchema),
        ) ||
        new Set(deferredDefinitions.map((definition) => definition.name)).size !==
          deferredDefinitions.length
      )
        return undefined;
      const combined = [...(selection.frozenDefinitions ?? []), ...deferredDefinitions];
      if (
        combined.length > MAX_NAMES ||
        Buffer.byteLength(JSON.stringify(combined)) > MAX_FROZEN_DEFINITIONS_BYTES
      )
        return undefined;
      selection.deferredDefinitions = JSON.parse(JSON.stringify(deferredDefinitions));
    }
    return selection;
  } catch {
    return undefined;
  }
}

/** Current eligibility plus a frozen provider prefix, owned by one Engine run. */
export class RunToolSurface {
  readonly toolDiscovery: "call-tool" | "tool-reference";
  private readonly initialToolNames: readonly string[] | undefined;
  private readonly topNames = new Set<string>();
  private readonly discoveredNames = new Set<string>();
  private readonly frozenByName = new Map<string, ToolDefinition>();
  private readonly deferredByName = new Map<string, ToolDefinition>();
  private readonly hasPersistedSelection: boolean;
  private readonly hasPersistedSnapshot: boolean;
  private readonly hasPersistedDeferredSnapshot: boolean;
  private readonly migrateLegacySelection: boolean;
  private readonly cacheIdentity?: string;
  private readonly cacheVersion?: string;
  private lastRequestAt?: number;
  private readonly canExposeDefinition: (definition: ToolDefinition) => boolean;
  private behaviorToolNames?: readonly string[];
  private frozenSnapshot?: ToolDefinition[];
  private deferredSnapshot?: ToolDefinition[];
  private wireSnapshot?: ToolDefinition[];
  private selectionSnapshot?: SessionToolSelection;
  private initialized = false;
  private catalog: readonly ToolDefinition[] = Object.freeze([]);
  private catalogByName = new Map<string, ToolDefinition>();
  private readonly onSelectionChanged?: (selection: SessionToolSelection) => void;

  constructor(
    initialToolNames?: readonly string[],
    options: {
      selection?: unknown;
      toolDiscovery?: "call-tool" | "tool-reference";
      /** Current application version, including a newly initialized cycle. */
      cacheVersion?: string;
      cacheIdentity?: string;
      /** Transport compatibility only; never changes current execution eligibility. */
      canExposeDefinition?: (definition: ToolDefinition) => boolean;
      onSelectionChanged?: (selection: SessionToolSelection) => void;
    } = {},
  ) {
    this.initialToolNames = initialToolNames ? [...initialToolNames] : undefined;
    this.toolDiscovery = options.toolDiscovery ?? "call-tool";
    this.canExposeDefinition = options.canExposeDefinition ?? (() => true);
    const selection = normalizeSessionToolSelection(options.selection);
    this.hasPersistedSelection = selection !== undefined;
    this.hasPersistedSnapshot = selection?.frozenDefinitions !== undefined;
    this.hasPersistedDeferredSnapshot = selection?.deferredDefinitions !== undefined;
    this.migrateLegacySelection =
      !!selection && (options.selection as { version?: unknown }).version === 1;
    this.cacheIdentity = options.cacheIdentity ?? selection?.cacheIdentity;
    this.cacheVersion = options.cacheVersion ?? selection?.cacheVersion;
    this.lastRequestAt = selection?.lastRequestAt;
    if (selection?.behaviorToolNames !== undefined)
      this.behaviorToolNames = Object.freeze([...selection.behaviorToolNames]);
    for (const name of selection?.names ?? []) this.topNames.add(name);
    for (const name of selection?.discovered ?? []) this.discoveredNames.add(name);
    for (const definition of selection?.frozenDefinitions ?? []) {
      this.frozenByName.set(definition.name, cloneDefinition(definition));
    }
    for (const definition of selection?.deferredDefinitions ?? []) {
      this.deferredByName.set(definition.name, cloneDefinition(definition));
    }
    this.onSelectionChanged = options.onSelectionChanged;
  }

  /** Refresh eligibility without changing an existing provider prefix. */
  updateCatalog(definitions: readonly ToolDefinition[]): void {
    const byName = new Map<string, ToolDefinition>();
    for (const definition of definitions) byName.set(definition.name, cloneDefinition(definition));
    this.catalogByName = byName;
    this.catalog = Object.freeze([...byName.values()]);
    if (this.initialized) return;
    this.initialized = true;
    this.behaviorToolNames ??= Object.freeze([...byName.keys()]);
    if (!this.hasPersistedSelection) {
      // Without discovery, all initially eligible tools must remain reachable.
      const initialNames = byName.has("ToolSearch")
        ? (this.initialToolNames ?? [...byName.keys()])
        : [...byName.keys()];
      for (const name of initialNames) {
        if (byName.has(name) && name !== "CallTool") this.topNames.add(name);
      }
      if (byName.has("ToolSearch")) this.topNames.add("ToolSearch");
    }
    // Also upgrades legacy selections made before CallTool existed.
    if (
      (!this.hasPersistedSelection ||
        this.migrateLegacySelection ||
        (this.toolDiscovery === "tool-reference" && !this.hasPersistedSnapshot)) &&
      this.topNames.has("ToolSearch") &&
      byName.has("CallTool")
    )
      this.topNames.add("CallTool");
    // An explicit snapshot is complete, even if a retained name had no schema
    // at the cold boundary. Filling those holes on resume would grow the prefix.
    if (!this.hasPersistedSnapshot) {
      for (const name of this.topNames) {
        const definition = byName.get(name);
        if (!definition) continue;
        if (this.canExposeDefinition(definition)) this.frozenByName.set(name, definition);
        else {
          // Initial selection already made this tool callable. Keep that grant
          // through the fallback adapter without sending an incompatible schema.
          this.topNames.delete(name);
          this.discoveredNames.add(name);
        }
      }
    }
    if (!this.hasPersistedDeferredSnapshot) this.rebuildDeferredSnapshot();
    this.invalidateSnapshots();
    this.onSelectionChanged?.(this.getSelection());
  }

  getCatalog(): readonly ToolDefinition[] {
    return this.catalog;
  }

  /** The current authorized schema, never a stale frozen definition. */
  getDefinition(name: string): ToolDefinition | undefined {
    return this.catalogByName.get(name);
  }

  select(names: readonly string[]): { selected: string[]; unavailable: string[] } {
    const previousSize = this.discoveredNames.size;
    const selected: string[] = [];
    const unavailable: string[] = [];
    for (const name of new Set(names)) {
      if (this.isEligible(name)) {
        if (!this.frozenByName.has(name)) this.discoveredNames.add(name);
        selected.push(name);
      } else {
        unavailable.push(name);
      }
    }
    if (this.discoveredNames.size !== previousSize) {
      this.selectionSnapshot = undefined;
      this.onSelectionChanged?.(this.getSelection());
    }
    return { selected, unavailable };
  }

  /** Start a cold cache cycle after compaction or a model/route change. */
  rebase(): void {
    for (const name of this.discoveredNames) {
      const definition = this.catalogByName.get(name);
      if (definition && !this.canExposeDefinition(definition)) continue;
      this.topNames.add(name);
      this.discoveredNames.delete(name);
    }
    for (const name of this.topNames) {
      const definition = this.catalogByName.get(name);
      if (!definition) continue;
      if (this.canExposeDefinition(definition)) this.frozenByName.set(name, definition);
      else {
        this.topNames.delete(name);
        this.frozenByName.delete(name);
        this.discoveredNames.add(name);
      }
    }
    this.rebuildDeferredSnapshot();
    this.behaviorToolNames = Object.freeze([...this.catalogByName.keys()]);
    this.lastRequestAt = undefined;
    this.invalidateSnapshots();
    this.onSelectionChanged?.(this.getSelection());
  }

  getSelection(): SessionToolSelection {
    return (this.selectionSnapshot ??= Object.freeze({
      version: 2,
      names: Object.freeze([...this.topNames]) as unknown as string[],
      discovered: Object.freeze([...this.discoveredNames]) as unknown as string[],
      frozenDefinitions: this.snapshot(),
      ...(this.toolDiscovery === "tool-reference" || this.hasPersistedDeferredSnapshot
        ? {
            deferredDefinitions: (this.deferredSnapshot ??= Object.freeze([
              ...this.deferredByName.values(),
            ]) as unknown as ToolDefinition[]),
          }
        : {}),
      ...(this.behaviorToolNames !== undefined
        ? { behaviorToolNames: this.behaviorToolNames as string[] }
        : {}),
      ...(this.cacheIdentity !== undefined ? { cacheIdentity: this.cacheIdentity } : {}),
      ...(this.cacheVersion !== undefined ? { cacheVersion: this.cacheVersion } : {}),
      ...(this.lastRequestAt !== undefined ? { lastRequestAt: this.lastRequestAt } : {}),
    }));
  }

  /** Record only a successful primary response; schema/behavior snapshots stay frozen. */
  recordRequest(at: number): void {
    if (!validRequestTime(at)) throw new RangeError("Invalid tool-cache request timestamp");
    if (this.lastRequestAt === at) return;
    this.lastRequestAt = at;
    this.selectionSnapshot = undefined;
    this.onSelectionChanged?.(this.getSelection());
  }

  /** Frozen cycle-start catalog names for behavior text, never execution authority. */
  behaviorSnapshot(): readonly string[] {
    return this.behaviorToolNames ?? EMPTY_NAMES;
  }

  /** Shared immutable schemas, including temporarily unavailable tools. */
  snapshot(): ToolDefinition[] {
    if (this.frozenSnapshot) return this.frozenSnapshot;
    const definitions: ToolDefinition[] = [];
    for (const name of this.topNames) {
      const definition = this.frozenByName.get(name);
      if (definition) definitions.push(definition);
    }
    return (this.frozenSnapshot = Object.freeze(definitions) as unknown as ToolDefinition[]);
  }

  /** Full wire catalog; deferred schemas never make a tool callable by themselves. */
  requestSnapshot(): ToolDefinition[] {
    if (this.toolDiscovery !== "tool-reference") return this.snapshot();
    return (this.wireSnapshot ??= Object.freeze([
      ...this.snapshot(),
      ...[...this.deferredByName.values()].map((definition) =>
        Object.freeze({ ...definition, deferLoading: true as const }),
      ),
    ]) as unknown as ToolDefinition[]);
  }

  private invalidateSnapshots(): void {
    this.frozenSnapshot = undefined;
    this.deferredSnapshot = undefined;
    this.wireSnapshot = undefined;
    this.selectionSnapshot = undefined;
  }

  private rebuildDeferredSnapshot(): void {
    this.deferredByName.clear();
    if (this.toolDiscovery !== "tool-reference" || !this.frozenByName.has("ToolSearch")) return;
    let count = this.frozenByName.size;
    let length = Buffer.byteLength(JSON.stringify([...this.frozenByName.values()]));
    for (const definition of this.catalog) {
      if (
        definition.name === "CallTool" ||
        this.topNames.has(definition.name) ||
        !validNames([definition.name]) ||
        !this.canExposeDefinition(definition)
      )
        continue;
      const addedLength = Buffer.byteLength(JSON.stringify(definition)) + 1;
      // A catalog beyond durable snapshot bounds remains available through text + CallTool.
      if (count >= MAX_NAMES || length + addedLength > MAX_FROZEN_DEFINITIONS_BYTES) continue;
      this.deferredByName.set(definition.name, definition);
      count++;
      length += addedLength;
    }
  }

  isCallable(name: string): boolean {
    return this.isEligible(name) && (this.frozenByName.has(name) || this.discoveredNames.has(name));
  }

  /** @deprecated Use isCallable: discovery no longer changes the provider's tools. */
  isSelected(name: string): boolean {
    return this.isCallable(name);
  }

  isEligible(name: string): boolean {
    return this.catalogByName.has(name);
  }
}

/** Loading mode belongs to the request projection, never to registry or eager state. */
function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  const { deferLoading: _deferLoading, ...schema } = definition;
  return cloneFrozen(schema);
}

function validRequestTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
