import type { ListSessions } from "../../shared/disk-session-query.js";
import { HostRevokedError } from "./authority.js";
import type { DesktopBusinessReads } from "../../shared/desktop-business-contracts.js";
import type { HostRequestContext } from "./authority.js";
import { InvalidParams, type DesktopHostMethod } from "./server.js";

/** DesktopHostServer captures the authorized document before calling run and
 * rechecks it after completion. A service can recheck between await points. */
export function businessRead<K extends keyof DesktopBusinessReads>(
  name: K,
  parse: (params: unknown) => DesktopBusinessReads[K]["params"],
  read: (
    params: DesktopBusinessReads[K]["params"],
    context: HostRequestContext,
  ) => DesktopBusinessReads[K]["result"] | Promise<DesktopBusinessReads[K]["result"]>,
): [K, DesktopHostMethod] {
  return [
    name,
    {
      run(context, params) {
        return read(parse(params), context);
      },
    },
  ];
}

export function noBusinessArguments(params: unknown): Record<string, never> {
  if (
    params !== undefined &&
    (!params ||
      typeof params !== "object" ||
      (Object.getPrototypeOf(params) !== Object.prototype &&
        Object.getPrototypeOf(params) !== null) ||
      Reflect.ownKeys(params).length > 0)
  )
    throw new InvalidParams("Unexpected business read arguments");
  return {};
}

/** Parse only the named fields of a structured-cloneable RPC parameter object. */
export function businessArguments(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    !Reflect.ownKeys(input).every((k) => typeof k === "string" && allowed.includes(k))
  )
    throw new InvalidParams("Unexpected business read arguments");
  return input as Record<string, unknown>;
}

export function textArgument(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 32_768)
    throw new InvalidParams("Expected a bounded nonempty string");
  return value;
}

/** A document may consult an unowned session only while the same visible
 * history row and its grant survive the complete service call. */
export function scopedBusinessRead<K extends keyof DesktopBusinessReads>(
  name: K,
  list: ListSessions,
  parse: (params: unknown) => DesktopBusinessReads[K]["params"],
  scope: (input: DesktopBusinessReads[K]["params"]) => string | undefined,
  read: (
    input: DesktopBusinessReads[K]["params"],
    ctx: HostRequestContext,
  ) => DesktopBusinessReads[K]["result"] | Promise<DesktopBusinessReads[K]["result"]>,
): [K, DesktopHostMethod] {
  const [, method] = businessRead(name, parse, async (input, ctx) => {
    const id = scope(input);
    const check = async () => {
      if (
        ctx.historical &&
        id &&
        !(await list({ sessionId: id, limit: 1 })).sessions.some((row) => row.id === id)
      )
        throw new HostRevokedError();
      ctx.assertCurrent();
    };
    await check();
    const result = await read(input, ctx);
    await check();
    return result;
  });
  return [
    name,
    { ...method, historyRead: "operation", optionalSessionId: (params) => scope(parse(params)) },
  ];
}
