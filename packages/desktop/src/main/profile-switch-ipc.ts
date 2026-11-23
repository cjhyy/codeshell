import type { IpcMainInvokeEvent } from "electron";
import type {
  RendererConfigurationTarget,
  ResolvedRendererConfigurationTarget,
} from "./renderer-configuration-authority.js";
import type { ProfileSwitchTarget } from "../shared/profile-switch-authority.js";
import type { ProfileSwitchAdoptResult, ProfileSwitchPreview } from "../shared/profile-switch.js";
import type { DesktopHostSupervisor } from "./desktop-host/main-supervisor.js";
import { answerProfileCredentialQuestions } from "./credential-access-service.js";

interface ProfileSwitchIpcDeps {
  ipcMain: {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void;
  };
  resolveTarget(target: unknown): Promise<ResolvedRendererConfigurationTarget>;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
  preview(
    target: ProfileSwitchTarget,
    name: string | null,
    signal: AbortSignal,
  ): ProfileSwitchPreview | Promise<ProfileSwitchPreview>;
  adopt(
    target: ProfileSwitchTarget,
    name: string | null,
    revision: string,
    signal: AbortSignal,
  ): ProfileSwitchAdoptResult | Promise<ProfileSwitchAdoptResult>;
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
  deps.ipcMain.handle("profiles:previewSwitch", async (event, target, name) => {
    const signal = deps.documentSignal(event);
    return deps.preview(await resolve(target), name, signal);
  });
  deps.ipcMain.handle("profiles:adoptSwitch", async (event, target, name, expectedRevision) => {
    const signal = deps.documentSignal(event);
    const resolved = await resolve(target);
    // A stale review must skip the gate's worker reload/notification as well as its write.
    const stale = new Error("profile switch review is stale");
    try {
      return await deps.withMutation(resolved.cwd, async () => {
        // Authority may change while waiting for admission. Never write an old, detached root.
        if (JSON.stringify(await resolve(target)) !== JSON.stringify(resolved)) throw stale;
        const result = await deps.adopt(resolved, name, expectedRevision, signal);
        if (result.status === "stale") throw stale;
        return result;
      });
    } catch (error) {
      if (error === stale) return { status: "stale" as const };
      throw error;
    }
  });
}

export function hostedProfileSwitch(
  host: Pick<DesktopHostSupervisor, "callBusiness">,
): Pick<ProfileSwitchIpcDeps, "preview" | "adopt"> {
  async function answers(target: ProfileSwitchTarget, signal: AbortSignal) {
    const questions = await host.callBusiness("profiles/switchSourceQuestions", { target }, signal);
    signal.throwIfAborted();
    return answerProfileCredentialQuestions(target.cwd, questions, () => signal.throwIfAborted());
  }
  return {
    async preview(target, name, signal) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await host.callBusiness(
          "profiles/previewSwitch",
          { target, name, answers: await answers(target, signal) },
          signal,
        );
        if (result.status === "ready") return result.preview;
      }
      throw Error("Profile bindings changed during review; please refresh");
    },
    async adopt(target, name, expectedRevision, signal) {
      return host.callBusiness(
        "profiles/adoptSwitch",
        { target, name, expectedRevision, answers: await answers(target, signal) },
        signal,
      );
    },
  };
}
