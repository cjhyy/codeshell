import { Workbench } from "./Workbench.js";
import { useHubController } from "./useHubController.js";
import type { CloudAccountControlsProps } from "./CloudAccountControls.js";

/** Hub authentication stays in AuthGate; hosts share the same browser view. */
export function App({
  onBackToProjects,
  projectName,
  cloudAccount,
  ...props
}: Parameters<typeof useHubController>[0] & {
  onBackToProjects?: () => void;
  projectName?: string;
  cloudAccount?: CloudAccountControlsProps;
}) {
  return (
    <Workbench
      controller={useHubController(props)}
      onBackToProjects={onBackToProjects}
      projectName={projectName}
      cloudAccount={cloudAccount}
    />
  );
}
