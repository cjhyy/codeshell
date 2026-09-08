import { Workbench } from "./Workbench.js";
import { useHubController } from "./useHubController.js";

/** Hub authentication stays in AuthGate; hosts share the same browser view. */
export function App({
  onBackToProjects,
  projectName,
  ...props
}: Parameters<typeof useHubController>[0] & {
  onBackToProjects?: () => void;
  projectName?: string;
}) {
  return (
    <Workbench
      controller={useHubController(props)}
      onBackToProjects={onBackToProjects}
      projectName={projectName}
    />
  );
}
