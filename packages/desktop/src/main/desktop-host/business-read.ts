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
