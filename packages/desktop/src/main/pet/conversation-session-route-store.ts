import { randomUUID } from "node:crypto";
import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";
import {
  CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION,
  activeBoundRoute,
  createConversationSessionRoute,
  enterConversationSessionRoute,
  isConversationSessionRouteExpired,
  leaveConversationSessionRoute,
  markConversationSessionRouteStalePrompted,
  parseConversationSessionRoute,
  recordConversationSessionRouteInbound,
  shouldPromptConversationSessionRouteStale,
  suspendConversationSessionRoute,
  type ConversationSessionRoute,
  type ConversationSessionRouteLeaveReason,
  type ConversationSessionRouteMode,
  type ConversationSessionRouteOrigin,
  type ConversationSessionRouteSuspendReason,
} from "@cjhyy/code-shell-pet";

const MAX_ROUTES = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOADED_ROWS = 5_000;

interface ConversationSessionRouteFile {
  version: typeof CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION;
  revision: number;
  routes: ConversationSessionRoute[];
}

export interface UpsertConversationSessionRouteInput {
  routeKey: string;
  channel: string;
  target: string;
  senderId: string;
  sessionId: string;
  sessionTitle: string;
  mode: ConversationSessionRouteMode;
  origin: ConversationSessionRouteOrigin;
}

/**
 * Durable IM-conversation ↔ Work-Session routing, owned exclusively by the
 * Electron main process.
 *
 * Single-writer on purpose: the chat CLI reaches main through the loopback
 * control plane rather than touching this file, so two processes can never
 * interleave writes to it. Lives beside the other Pet state under
 * `<userData>/pet/` because it is Pet-owned data with the same lifetime.
 */
export class ConversationSessionRouteStore {
  private routes = new Map<string, ConversationSessionRoute>();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private revision = 0;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  async all(): Promise<ConversationSessionRoute[]> {
    await this.load();
    return [...this.routes.values()];
  }

  /** Every route that still wants this Session's terminal outcome. */
  async notifyRoutesForSession(sessionId: string): Promise<ConversationSessionRoute[]> {
    await this.load();
    return [...this.routes.values()].filter(
      (route) => route.sessionId === sessionId && route.status === "active",
    );
  }

  /**
   * The Session this conversation is currently talking to, or undefined when
   * it should go to Mimi. Expiry is judged here rather than by a timer so a
   * route that aged out while the app was closed never captures a message.
   */
  async boundRoute(routeKey: string): Promise<ConversationSessionRoute | undefined> {
    await this.load();
    return activeBoundRoute([...this.routes.values()], routeKey, this.now());
  }

  async routeById(id: string): Promise<ConversationSessionRoute | undefined> {
    await this.load();
    return this.routes.get(id);
  }

  /**
   * Create or update this conversation's route to a Session. A conversation
   * may hold many `notify` routes but only one `bound` route: entering a
   * second Session leaves the first rather than silently fanning the user's
   * messages to both.
   */
  upsert(input: UpsertConversationSessionRouteInput): Promise<ConversationSessionRoute> {
    return this.mutate(() => {
      const now = this.now();
      const existing = [...this.routes.values()].find(
        (route) => route.routeKey === input.routeKey && route.sessionId === input.sessionId,
      );
      const staged = new Map(this.routes);
      if (input.mode === "bound") {
        for (const route of staged.values()) {
          if (route.routeKey === input.routeKey && route.mode === "bound") {
            staged.set(route.id, leaveConversationSessionRoute(route, now, "user"));
          }
        }
      }
      const next = existing
        ? input.mode === "bound"
          ? enterConversationSessionRoute(
              { ...(staged.get(existing.id) ?? existing), sessionTitle: input.sessionTitle },
              now,
            )
          : { ...existing, sessionTitle: input.sessionTitle, updatedAt: now }
        : createConversationSessionRoute({ id: `route-${randomUUID()}`, ...input, now });
      if (!next) throw new Error("refusing to store an unaddressable conversation session route");
      staged.set(next.id, next);
      return { staged, result: next };
    });
  }

  /** Downgrade to notify. Never deletes: the completion is still wanted. */
  leave(
    routeKey: string,
    reason: ConversationSessionRouteLeaveReason,
  ): Promise<ConversationSessionRoute | undefined> {
    return this.mutate(() => {
      const now = this.now();
      const staged = new Map(this.routes);
      let result: ConversationSessionRoute | undefined;
      for (const route of staged.values()) {
        if (route.routeKey !== routeKey || route.mode !== "bound") continue;
        result = leaveConversationSessionRoute(route, now, reason);
        staged.set(route.id, result);
      }
      return { staged, result };
    });
  }

  suspend(
    id: string,
    reason: ConversationSessionRouteSuspendReason,
  ): Promise<ConversationSessionRoute | undefined> {
    return this.mutate(() => {
      const staged = new Map(this.routes);
      const existing = staged.get(id);
      if (!existing) return { staged, result: undefined };
      const result = suspendConversationSessionRoute(existing, this.now(), reason);
      staged.set(id, result);
      return { staged, result };
    });
  }

  recordInbound(id: string): Promise<ConversationSessionRoute | undefined> {
    return this.mutate(() => {
      const staged = new Map(this.routes);
      const existing = staged.get(id);
      if (!existing) return { staged, result: undefined };
      const result = recordConversationSessionRouteInbound(existing, this.now());
      staged.set(id, result);
      return { staged, result };
    });
  }

  /**
   * Whether this message should first be told it is entering a Session, and
   * atomically stamp the reminder so a busy conversation is never nagged.
   */
  async consumeStalePrompt(id: string): Promise<boolean> {
    return this.mutate(() => {
      const staged = new Map(this.routes);
      const existing = staged.get(id);
      const now = this.now();
      if (!existing || !shouldPromptConversationSessionRouteStale(existing, now)) {
        return { staged, result: false };
      }
      staged.set(id, markConversationSessionRouteStalePrompted(existing, now));
      return { staged, result: true };
    });
  }

  /**
   * Downgrade bound routes that aged out. Called at startup and before
   * routing, so an expiry that elapsed while the app was closed still takes
   * effect before the next message is delivered.
   */
  expireStaleBoundRoutes(): Promise<ConversationSessionRoute[]> {
    return this.mutate(() => {
      const now = this.now();
      const staged = new Map(this.routes);
      const result: ConversationSessionRoute[] = [];
      for (const route of staged.values()) {
        if (!isConversationSessionRouteExpired(route, now)) continue;
        const left = leaveConversationSessionRoute(route, now, "expired");
        staged.set(route.id, left);
        result.push(left);
      }
      return { staged, result };
    });
  }

  private mutate<T>(
    apply: () => { staged: Map<string, ConversationSessionRoute>; result: T },
  ): Promise<T> {
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const { staged, result } = apply();
        // Trim oldest-updated first so an active conversation is never the one
        // evicted by a long tail of finished notify routes.
        if (staged.size > MAX_ROUTES) {
          const ordered = [...staged.values()].sort((a, b) => a.updatedAt - b.updatedAt);
          for (const route of ordered.slice(0, staged.size - MAX_ROUTES)) {
            if (route.mode !== "bound") staged.delete(route.id);
          }
        }
        this.revision += 1;
        await writeOwnerJsonAtomic(
          this.filePath,
          {
            version: CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION,
            revision: this.revision,
            routes: [...staged.values()],
          } satisfies ConversationSessionRouteFile,
          MAX_FILE_BYTES,
        );
        this.routes = staged;
        return result;
      });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk().catch((error) => {
        this.loadPromise = undefined;
        throw error;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = await readBoundedJson(this.filePath, MAX_FILE_BYTES);
    } catch (error) {
      // Unreadable state must not permanently disable routing, but the bytes
      // are kept for diagnosis rather than silently overwritten.
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "conversation_session_routes.unreadable", {
        error: error instanceof Error ? error.message : String(error),
        ...(quarantinePath ? { quarantinePath } : {}),
      });
      this.routes = new Map();
      return;
    }
    if (parsed === undefined) {
      this.routes = new Map();
      return;
    }
    const file = parsed as Partial<ConversationSessionRouteFile>;
    if (
      file.version !== CONVERSATION_SESSION_ROUTE_SCHEMA_VERSION ||
      !Array.isArray(file.routes) ||
      file.routes.length > MAX_LOADED_ROWS
    ) {
      const quarantinePath = await quarantineCorruptJson(this.filePath);
      dlog("main", "conversation_session_routes.unsupported", {
        ...(quarantinePath ? { quarantinePath } : {}),
      });
      this.routes = new Map();
      return;
    }
    const loaded = new Map<string, ConversationSessionRoute>();
    let dropped = 0;
    for (const row of file.routes) {
      const route = parseConversationSessionRoute(row);
      if (route) loaded.set(route.id, route);
      else dropped += 1;
    }
    if (dropped > 0) dlog("main", "conversation_session_routes.dropped_rows", { dropped });
    this.revision =
      typeof file.revision === "number" && Number.isSafeInteger(file.revision)
        ? Math.max(0, file.revision)
        : 0;
    this.routes = loaded;
  }
}
