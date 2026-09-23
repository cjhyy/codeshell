import { resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import { createPanelManagement, type PanelOperationContext } from "@cjhyy/code-shell-server/panels";
import type { PanelAppBindingState } from "../shared/panel-apps.js";

/** Trusted Desktop composition of the same conditional writer used by paired Web. */
export function createDesktopPanelManagement(
  cwd: string,
  options: {
    withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
    onChanged?: () => void | Promise<void>;
  } = {},
) {
  const bindingCwd = resolvePanelAppBindingProjectPath(cwd);
  const management = createPanelManagement({
    cwd,
    bindingCwd,
    projectPackages: true,
    assertBinding: () => {
      if (resolvePanelAppBindingProjectPath(cwd) !== bindingCwd)
        throw new Error("项目位置已改变，请刷新后重试。");
    },
    ...options,
  });
  function states(
    snapshot: Awaited<ReturnType<typeof management.snapshot>>,
  ): PanelAppBindingState[] {
    return snapshot.panels.map((app) => ({
      appId: app.id,
      revision: app.revision,
      bound: app.bound,
      globalDisabled: app.globalDisabled,
      version: app.version,
      packageDigest: app.packageDigest,
    }));
  }
  return {
    async snapshot() {
      return states(await management.snapshot());
    },
    async binding(
      context: PanelOperationContext,
      id: unknown,
      bound: unknown,
      expectedRevision: unknown,
    ) {
      return states(await management.binding(context, id, bound, expectedRevision));
    },
  };
}
