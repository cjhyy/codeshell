import {
  assertSafePanelAppId,
  checkInstalledPanelAppUpdate,
  getInstalledPanelAppUpdateIdentity,
  type InstalledPanelApp,
  type PanelAppUpdateCheck,
} from "@cjhyy/code-shell-core";

const CACHE_TTL_MS = 5 * 60_000;
const ERROR_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;

type Installation = Pick<InstalledPanelApp, "id" | "version" | "source" | "lastUpdated">;

function fingerprint(app: Installation): string {
  return JSON.stringify([app.id, app.version, app.source, app.lastUpdated]);
}

/** Cache only discovery results. Installation still requires a fresh full package review. */
export function createPanelAppUpdateService(deps: {
  getInstalled: (id: string) => Promise<Installation | undefined>;
  check: (id: string) => Promise<PanelAppUpdateCheck>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { key: string; expires: number; result: PanelAppUpdateCheck }>();
  const pending = new Map<string, { key: string; promise: Promise<PanelAppUpdateCheck> }>();

  function errorResult(
    id: string,
    app: Installation | undefined,
    message: string,
  ): PanelAppUpdateCheck {
    return {
      id,
      currentVersion: app?.version ?? "",
      status: "error",
      sourceKind:
        typeof app?.source === "object"
          ? "git"
          : app?.source?.toLowerCase().endsWith(".zip")
            ? "zip"
            : "dir",
      checkedAt: new Date(now()).toISOString(),
      message,
    };
  }

  return {
    invalidate(id: string) {
      cache.delete(id);
      // The old promise may finish, but may no longer populate the cache.
      pending.delete(id);
    },
    async check(id: string, force = false): Promise<PanelAppUpdateCheck> {
      assertSafePanelAppId(id);
      let app: Installation | undefined;
      try {
        app = await deps.getInstalled(id);
      } catch (error) {
        return errorResult(id, app, error instanceof Error ? error.message : String(error));
      }
      if (!app) {
        cache.delete(id);
        pending.delete(id);
        return errorResult(id, undefined, "Panel App is no longer installed");
      }
      const installed = app;
      const key = fingerprint(installed);
      const cached = cache.get(id);
      if (!force && cached?.key === key && cached.expires > now()) return cached.result;
      const active = pending.get(id);
      if (active?.key === key) return active.promise;
      const entry: { key: string; promise: Promise<PanelAppUpdateCheck> } = {
        key,
        promise: Promise.resolve()
          .then(async (): Promise<PanelAppUpdateCheck> => {
            let result: PanelAppUpdateCheck;
            try {
              result = await deps.check(id);
              const current = await deps.getInstalled(id);
              if (
                !current ||
                fingerprint(current) !== key ||
                result.currentVersion !== installed.version
              ) {
                return errorResult(id, current, "Panel App changed during the check; check again");
              }
            } catch (error) {
              result = errorResult(
                id,
                installed,
                error instanceof Error ? error.message : String(error),
              );
            }
            if (pending.get(id) === entry) {
              cache.delete(id);
              cache.set(id, {
                key,
                expires: now() + (result.status === "error" ? ERROR_TTL_MS : CACHE_TTL_MS),
                result,
              });
              while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
            }
            return result;
          })
          .finally(() => {
            if (pending.get(id) === entry) pending.delete(id);
          }),
      };
      pending.set(id, entry);
      return entry.promise;
    },
  };
}

export const panelAppUpdateService = createPanelAppUpdateService({
  getInstalled: getInstalledPanelAppUpdateIdentity,
  check: checkInstalledPanelAppUpdate,
});
