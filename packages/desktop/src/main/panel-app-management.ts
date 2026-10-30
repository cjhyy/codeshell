import {
  resolvePanelAppBindingProjectPath,
  type PanelAppSourceInput,
} from "@cjhyy/code-shell-core";
import {
  createPanelManagement,
  createPanelSnapshotReads,
  type PanelOperationContext,
  type PanelSnapshotReads,
} from "@cjhyy/code-shell-server/panels";
import type { PanelAppBindingState } from "../shared/panel-apps.js";

/** Trusted Desktop composition of the same conditional writer used by paired Web. */
export function createDesktopPanelManagement(
  cwd: string,
  options: {
    withMutation?: <T>(write: () => Promise<T>) => Promise<T>;
    onChanged?: (
      id: string,
      kind: "install" | "update" | "binding" | "remove",
    ) => void | Promise<void>;
  } = {},
) {
  const bindingCwd = resolvePanelAppBindingProjectPath(cwd);
  const management = createPanelManagement({
    cwd,
    bindingCwd,
    projectPackages: true,
    allowLocalSources: true,
    assertBinding: () => {
      if (resolvePanelAppBindingProjectPath(cwd) !== bindingCwd)
        throw new Error("项目位置已改变，请刷新后重试。");
    },
    ...options,
  });
  function states(
    snapshot: Awaited<ReturnType<typeof management.snapshot>>,
  ): PanelAppBindingState[] {
    return [
      ...snapshot.panels.map((app) => ({
        appId: app.id,
        revision: app.revision,
        bound: app.bound,
        globalDisabled: app.globalDisabled,
        version: app.version,
        packageDigest: app.packageDigest,
      })),
      ...(snapshot.issues ?? []).map((issue) => ({
        appId: issue.id,
        revision: issue.revision,
        bound: issue.bound,
        globalDisabled: issue.globalDisabled,
        version: issue.version ?? "未记录",
        packageDigest: issue.packageDigest,
        unavailable: true,
      })),
    ];
  }
  return {
    close: () => management.close(),
    cancelOwner: (owner: string) => management.cancelOwner(owner),
    packageHistory: management.packageHistory,
    previewRestore: management.previewRestore,
    cancelRestore: management.cancelRestore,
    restore: management.restore,
    previewSource: (context: PanelOperationContext, source: PanelAppSourceInput) =>
      management.previewProjectSource(context, source),
    previewUpdate: (context: PanelOperationContext, id: string, expectedRevision: string) =>
      management.previewProjectUpdate(context, id, expectedRevision),
    install: (
      context: PanelOperationContext,
      token: string,
      approval?: Parameters<typeof management.install>[3],
    ) => management.install(context, token, true, approval),
    async snapshot(reads?: PanelSnapshotReads) {
      return states(await management.snapshot(undefined, reads));
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

/** Bindings for several projects in request order, verifying each package once per request. */
export async function readDesktopPanelBindings(
  projectPaths: unknown,
  authorize: (path: string) => Promise<string>,
): Promise<Array<PanelAppBindingState[] | null>> {
  if (!Array.isArray(projectPaths) || projectPaths.length > 64) {
    throw new Error("panel-apps:bindingsForProjects requires projectPaths");
  }
  const reads = createPanelSnapshotReads();
  return Promise.all(
    projectPaths.map(async (path) => {
      try {
        return await createDesktopPanelManagement(await authorize(path)).snapshot(reads);
      } catch {
        // A stale project must not hide every other project's bindings.
        return null;
      }
    }),
  );
}
