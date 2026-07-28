import { homedir } from "node:os";
import { join } from "node:path";

export class PanelAppInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelAppInstallError";
  }
}

export class PanelAppReviewChangedError extends PanelAppInstallError {
  constructor() {
    super("Panel App source changed after review. Review it again before installing.");
    this.name = "PanelAppReviewChangedError";
  }
}

export class PanelAppAlreadyInstalledError extends PanelAppInstallError {
  constructor(id: string) {
    super(`Panel App '${id}' is already installed`);
    this.name = "PanelAppAlreadyInstalledError";
  }
}

function userHome(): string {
  return process.env.HOME ?? homedir();
}

export function assertSafePanelAppId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new PanelAppInstallError(`invalid Panel App id: ${JSON.stringify(id)}`);
  }
}

export function panelAppsRoot(): string {
  return join(userHome(), ".code-shell", "panel-apps");
}

export function panelAppInstallDir(id: string): string {
  assertSafePanelAppId(id);
  return join(panelAppsRoot(), id);
}

export function panelAppsRegistryPath(): string {
  return join(panelAppsRoot(), "installed.json");
}
