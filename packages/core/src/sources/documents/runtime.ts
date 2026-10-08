import { createManagedRuntimeProvider } from "../../runtime/managed-runtime.js";

/**
 * Trusted Host distribution only. No PATH search, downloads, project settings,
 * protocol parameters or model-selected executable. Integrity is checked on
 * every uncached PDF parse before choosing this separate Node process.
 */
export function createManagedDocumentParserResolver(root: string) {
  const provider = createManagedRuntimeProvider({ root });
  return async (signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const runtime = await provider.resolve("node");
    signal?.throwIfAborted();
    if (!runtime)
      throw new Error(
        "The Host-managed Node runtime is missing; reinstall CodeShell or prepare its managed runtime in development, or export the PDF as UTF-8 text.",
      );
    const version = /^(\d+)\.(\d+)\./.exec(runtime.version);
    const major = Number(version?.[1]);
    const minor = Number(version?.[2]);
    if (!version || major < 22 || (major === 22 && minor < 13))
      throw new Error("The Host-managed PDF runtime requires Node.js 22.13 or newer");
    return runtime.executablePath;
  };
}
