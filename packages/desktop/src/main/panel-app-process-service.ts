/** Shared pure-Node implementation; Electron supplies dialogs and ownership checks. */
export {
  PanelAppProcessService,
  panelExecutableDirectories,
  panelProcessInfo,
  resolvePanelExecutable,
  type PanelAppProcessServiceOptions,
  type PanelProcessApprovalScope,
  type PanelProcessOwner,
} from "@cjhyy/code-shell-server/panels";
