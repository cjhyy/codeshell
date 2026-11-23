import { app } from "electron";
import { join } from "node:path";
import { dlog } from "../desktop-logger.js";
import { injectLoginShellPathAtStartup } from "../login-shell-path.js";
import { injectDesktopManagedRuntimePath } from "../managed-runtime-service.js";

/** Start this alongside native window initialization. Only executable-dependent work awaits it. */
export async function prepareDesktopRuntimePath(): Promise<void> {
  await injectLoginShellPathAtStartup({
    log: (event, data) => dlog("main", event, data),
  }).catch((error) => dlog("main", "login-shell-path.failed", { error: String(error) }));

  // Child tools inherit appended fallbacks; existing and project PATHs keep precedence.
  await injectDesktopManagedRuntimePath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    additionalDirectories: [join(app.getPath("userData"), "bin")],
  })
    .then((result) => dlog("main", "managed-runtime-path.ready", result))
    .catch((error) => dlog("main", "managed-runtime-path.failed", { error: String(error) }));
}
