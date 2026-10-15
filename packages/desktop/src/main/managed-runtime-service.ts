import { dirname, join } from "node:path";
import { createManagedRuntimeProvider } from "@cjhyy/code-shell-core/internal";

export interface DesktopManagedRuntimeOptions {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function desktopManagedRuntimeRoot(options: DesktopManagedRuntimeOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath, "runtimes")
    : join(options.appPath, "out", "managed-runtimes");
}

/** Locate application-owned runtimes without selecting one for any consumer. */
export function createDesktopManagedRuntimeProvider(options: DesktopManagedRuntimeOptions) {
  return createManagedRuntimeProvider({
    root: desktopManagedRuntimeRoot(options),
    platform: options.platform,
    arch: options.arch,
  });
}

/** Add Host-owned executable fallbacks without replacing the user's PATH choices. */
export async function injectDesktopManagedRuntimePath(
  options: DesktopManagedRuntimeOptions & {
    env?: NodeJS.ProcessEnv;
    additionalDirectories?: readonly string[];
  },
): Promise<{ nodeAvailable: boolean; addedPathEntryCount: number }> {
  // Verify on repeated calls too. A failed verification leaves the original
  // environment intact instead of adding an unverified executable fallback.
  const runtime = await createDesktopManagedRuntimeProvider(options).resolve("node");
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const delimiter = windows ? ";" : ":";
  const pathKey =
    windows && env.PATH === undefined
      ? (Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH")
      : "PATH";
  const before = env[pathKey] ?? "";
  const identity = (path: string) => (windows ? path.toLowerCase() : path);
  const existing = new Set(before.split(delimiter).filter(Boolean).map(identity));
  const added: string[] = [];
  for (const directory of [
    ...(options.additionalDirectories ?? []),
    ...(runtime ? [dirname(runtime.executablePath)] : []),
  ]) {
    if (!directory || existing.has(identity(directory))) continue;
    existing.add(identity(directory));
    added.push(directory);
  }
  if (added.length) env[pathKey] = [before, ...added].filter(Boolean).join(delimiter);
  return { nodeAvailable: !!runtime, addedPathEntryCount: added.length };
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
