import { join } from "node:path";
import { createManagedRuntimeProvider } from "@cjhyy/code-shell-core/internal";

export interface DesktopManagedRuntimeOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** Locate application-owned runtimes without selecting one for any consumer. */
export function createDesktopManagedRuntimeProvider(options: DesktopManagedRuntimeOptions) {
  return createManagedRuntimeProvider({
    root: options.isPackaged
      ? join(options.resourcesPath, "runtimes")
      : join(options.appPath, "out", "managed-runtimes"),
    platform: options.platform,
    arch: options.arch,
  });
}

/** Read-only Desktop discovery. Resolving a path is not execution authorization. */
export function createManagedRuntimeHandlers<Event>(
  provider: ReturnType<typeof createManagedRuntimeProvider>,
  isHostSender: (event: Event) => boolean,
) {
  const authorize = (event: Event) => {
    if (!isHostSender(event)) throw new Error("Managed runtimes require a Desktop host sender");
  };
  return {
    list(event: Event) {
      authorize(event);
      return provider.list();
    },
    resolve(event: Event, id: unknown) {
      authorize(event);
      if (typeof id !== "string") throw new Error("Managed runtime id must be a string");
      return provider.resolve(id);
    },
  };
}
