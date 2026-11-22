import type {
  previewLocalPluginForUi,
  installLocalPluginForUi,
} from "../main/marketplace-service.js";
import type { checkPluginUpdateEntry } from "../main/plugins-service.js";
type Operation<F extends (...args: any[]) => unknown> = {
  input: Parameters<F>[0];
  result: Awaited<ReturnType<F>>;
};
export interface PluginPackageOperations {
  "plugins/previewLocal": Operation<typeof previewLocalPluginForUi>;
  "plugins/installLocal": Operation<typeof installLocalPluginForUi>;
  "plugins/uninstallLocal": { input: { name: string }; result: void };
  "plugins/checkUpdate": {
    input: { name: string };
    result: Awaited<ReturnType<typeof checkPluginUpdateEntry>>;
  };
}
