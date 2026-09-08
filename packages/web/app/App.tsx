import { Workbench } from "./Workbench.js";
import { useHubController } from "./useHubController.js";

/** Hub authentication stays in AuthGate; hosts share the same browser view. */
export function App(props: Parameters<typeof useHubController>[0]) {
  return <Workbench controller={useHubController(props)} />;
}
