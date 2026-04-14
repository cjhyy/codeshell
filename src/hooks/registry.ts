/**
 * Hook registry with priority-based chain-of-responsibility execution.
 */

import type { HookEventName, HookContext, HookResult } from "./events.js";

export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult>;

interface RegisteredHook {
  handler: HookHandler;
  priority: number;
  name?: string;
}

export class HookRegistry {
  private hooks = new Map<HookEventName, RegisteredHook[]>();

  register(eventName: HookEventName, handler: HookHandler, priority = 0, name?: string): void {
    if (!this.hooks.has(eventName)) {
      this.hooks.set(eventName, []);
    }
    this.hooks.get(eventName)!.push({ handler, priority, name });
    // Sort by priority descending (highest first)
    this.hooks.get(eventName)!.sort((a, b) => b.priority - a.priority);
  }

  async emit(eventName: HookEventName, data: Record<string, unknown> = {}): Promise<HookResult> {
    const handlers = this.hooks.get(eventName);
    if (!handlers?.length) return {};

    const ctx: HookContext = { eventName, data: { ...data } };
    let aggregated: HookResult = {};

    for (const { handler } of handlers) {
      try {
        const result = await handler(ctx);
        if (result.data) {
          ctx.data = { ...ctx.data, ...result.data };
          aggregated.data = { ...aggregated.data, ...result.data };
        }
        if (result.messages) {
          aggregated.messages = [...(aggregated.messages ?? []), ...result.messages];
        }
        if (result.decision) {
          aggregated.decision = result.decision;
        }
        if (result.stop) {
          aggregated.stop = true;
          break;
        }
      } catch (err) {
        // Hook errors should not crash the main loop
        console.error(`Hook error in ${eventName}:`, err);
      }
    }

    return aggregated;
  }

  hasHooks(eventName: HookEventName): boolean {
    return (this.hooks.get(eventName)?.length ?? 0) > 0;
  }

  clear(eventName?: HookEventName): void {
    if (eventName) {
      this.hooks.delete(eventName);
    } else {
      this.hooks.clear();
    }
  }

  listHooks(): Map<HookEventName, string[]> {
    const result = new Map<HookEventName, string[]>();
    for (const [name, handlers] of this.hooks) {
      result.set(
        name,
        handlers.map((h) => h.name ?? "(anonymous)"),
      );
    }
    return result;
  }

  listEvents(): HookEventName[] {
    return [...this.hooks.keys()];
  }

  countHandlers(eventName: HookEventName): number {
    return this.hooks.get(eventName)?.length ?? 0;
  }
}
