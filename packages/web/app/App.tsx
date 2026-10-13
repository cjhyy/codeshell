import { Workbench } from "./Workbench.js";
import { useHubController } from "./useHubController.js";
import type { CloudAccountControlsProps } from "./CloudAccountControls.js";
import type React from "react";
import type { WorkbenchNavigation } from "./workbench-types.js";

/** Hub authentication stays in AuthGate; hosts share the same browser view. */
export function App({
  onBackToProjects,
  projectName,
  cloudAccount,
  renderAccountControl,
  ...props
}: Parameters<typeof useHubController>[0] & {
  onBackToProjects?: () => void;
  projectName?: string;
  cloudAccount?: CloudAccountControlsProps;
  renderAccountControl?: (navigation: WorkbenchNavigation) => React.ReactNode;
}) {
  return (
    <Workbench
      controller={useHubController(props)}
      onBackToProjects={onBackToProjects}
      projectName={projectName}
      cloudAccount={cloudAccount}
      renderAccountControl={renderAccountControl}
    />
  );
}
