import type {
  PanelPackageHistory,
  PanelPackageRestoreReview,
} from "@cjhyy/code-shell-server/panels";

import type { PanelAppMutationFailure } from "../shared/panel-apps.js";

/** Version selection stays bound to the reviewed project and Host-issued token. */
export interface ProjectPanelVersionApi {
  getPanelAppPackageHistory(
    cwd: string,
    id: string,
    revision: string,
  ): Promise<PanelPackageHistory>;
  previewPanelAppRestore(
    cwd: string,
    id: string,
    digest: string,
    revision: string,
  ): Promise<PanelPackageRestoreReview>;
  restorePanelAppPackage(
    cwd: string,
    token: string,
  ): Promise<{ ok: true; id: string; packageDigest: string } | PanelAppMutationFailure>;
  cancelPanelAppRestore(cwd: string, token: string): Promise<{ cancelled: boolean }>;
}
