import type {
  RendererConfigurationTarget,
  ResolvedRendererConfigurationTarget,
} from "./renderer-configuration-authority.js";
import { adoptProfileSwitch, previewProfileSwitch } from "./profile-switch-service.js";

interface ProfileSwitchIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: unknown, ...args: any[]) => any): void };
  resolveTarget(target: unknown): Promise<ResolvedRendererConfigurationTarget>;
  withMutation<T>(cwd: string, write: () => Promise<T>): Promise<T>;
}

/** Preview and adoption share the same authoritative target resolver as existing settings. */
export function registerProfileSwitchIpc(deps: ProfileSwitchIpcDeps): void {
  const resolve = async (target: RendererConfigurationTarget) => {
    // Resolving no-repo can create its directory. Reject before resolution for a zero-write preview.
    if (target && typeof target === "object" && "noRepo" in target)
      throw new Error("请选择项目后再切换默认数字人。");
    const resolved = await deps.resolveTarget(target);
    if (resolved.kind === "no-repo")
      throw new Error("Profile switching requires a project or Session configuration target");
    return resolved;
  };
  deps.ipcMain.handle("profiles:previewSwitch", async (_event, target, name) =>
    previewProfileSwitch(await resolve(target), name),
  );
  deps.ipcMain.handle("profiles:adoptSwitch", async (_event, target, name, expectedRevision) => {
    const resolved = await resolve(target);
    // A stale review must skip the gate's worker reload/notification as well as its write.
    const stale = new Error("profile switch review is stale");
    try {
      return await deps.withMutation(resolved.cwd, async () => {
        // Authority may change while waiting for admission. Never write an old, detached root.
        if (JSON.stringify(await resolve(target)) !== JSON.stringify(resolved)) throw stale;
        const result = adoptProfileSwitch(resolved, name, expectedRevision);
        if (result.status === "stale") throw stale;
        return result;
      });
    } catch (error) {
      if (error === stale) return { status: "stale" as const };
      throw error;
    }
  });
}
