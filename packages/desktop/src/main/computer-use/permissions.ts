import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ComputerUsePermissionKind,
  ComputerUsePermissionState,
  ComputerUsePermissionStatus,
} from "../../shared/computer-use.js";

export type {
  ComputerUsePermissionKind,
  ComputerUsePermissionState,
  ComputerUsePermissionStatus,
} from "../../shared/computer-use.js";

export interface PermissionHelperOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly detached: false;
}

export interface ComputerUsePermissionsOptions {
  readonly platform: NodeJS.Platform;
  readonly systemPreferences: {
    isTrustedAccessibilityClient(prompt: boolean): boolean;
    getMediaAccessStatus(mediaType: "screen"): string;
  };
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Main-owned path resolved from the app's resources, never from renderer input. */
  readonly helperPath?: string;
  readonly parentEnv?: NodeJS.ProcessEnv;
  readonly isExecutable?: (path: string) => boolean;
  readonly runHelper?: (
    path: string,
    args: string[],
    options: PermissionHelperOptions,
  ) => Promise<string>;
}

export interface ComputerUsePermissionsController {
  status(): Promise<ComputerUsePermissionStatus>;
  request(kind: ComputerUsePermissionKind): Promise<ComputerUsePermissionStatus>;
  openSettings(kind: ComputerUsePermissionKind): Promise<void>;
}

const SETTINGS: Record<ComputerUsePermissionKind, string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveComputerUsePermissionsHelper(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "computer-use", "codeshell-permissions")
    : join(options.appPath, "out", "native", "codeshell-permissions");
}

function runHelper(
  path: string,
  args: string[],
  options: PermissionHelperOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // A direct child of Electron keeps the host's macOS TCC responsibility.
    execFile(path, args, { ...options, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateKind(kind: ComputerUsePermissionKind): void {
  if (kind !== "accessibility" && kind !== "screenRecording") {
    throw new Error("Unknown computer use permission");
  }
}

/**
 * Reading status never requests OS permissions. Only the main-process handler
 * for an explicit user click may call request(). Agent tools cannot use it.
 */
export function createComputerUsePermissionsController(
  options: ComputerUsePermissionsOptions,
): ComputerUsePermissionsController {
  let restartRequired = false;
  let previous: Pick<ComputerUsePermissionStatus, "accessibility" | "screenRecording"> | undefined;
  const requests = new Map<ComputerUsePermissionKind, Promise<ComputerUsePermissionStatus>>();
  const executable = options.isExecutable ?? isExecutable;

  async function status(error?: string): Promise<ComputerUsePermissionStatus> {
    if (options.platform !== "darwin") {
      return {
        supported: false,
        accessibility: "unsupported",
        screenRecording: "unsupported",
        screenRequestAvailable: false,
        restartRequired: false,
      };
    }
    let accessibility: ComputerUsePermissionState = "unknown";
    let screenRecording: ComputerUsePermissionState = "unknown";
    const errors: string[] = error ? [error] : [];
    try {
      accessibility = options.systemPreferences.isTrustedAccessibilityClient(false)
        ? "granted"
        : "denied";
    } catch (cause) {
      errors.push(`Accessibility status unavailable: ${message(cause)}`);
    }
    try {
      const screen = options.systemPreferences.getMediaAccessStatus("screen");
      screenRecording =
        screen === "granted"
          ? "granted"
          : screen === "denied" || screen === "restricted" || screen === "not-determined"
            ? "denied"
            : "unknown";
    } catch (cause) {
      errors.push(`Screen recording status unavailable: ${message(cause)}`);
    }
    // The running Cua daemon can cache a denied TCC result. A newly granted
    // permission needs a full app restart even when this fresh read sees it.
    if (
      previous &&
      ((previous.accessibility === "denied" && accessibility === "granted") ||
        (previous.screenRecording === "denied" && screenRecording === "granted"))
    ) {
      restartRequired = true;
    }
    previous = { accessibility, screenRecording };
    return {
      supported: true,
      accessibility,
      screenRecording,
      screenRequestAvailable: !!options.helperPath && executable(options.helperPath),
      restartRequired,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  }

  async function requestPermission(
    kind: ComputerUsePermissionKind,
  ): Promise<ComputerUsePermissionStatus> {
    const before = await status();
    if (!before.supported) throw new Error("Computer use permissions require macOS");
    if (before[kind] === "granted") return before;
    try {
      if (kind === "accessibility") {
        options.systemPreferences.isTrustedAccessibilityClient(true);
      } else {
        if (!before.screenRequestAvailable || !options.helperPath) {
          throw new Error("Screen recording permission helper is unavailable; rebuild CodeShell");
        }
        const parentEnv = options.parentEnv ?? process.env;
        const env: NodeJS.ProcessEnv = {};
        for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"]) {
          if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
        }
        // Even an interrupted native prompt may have changed the OS grant.
        restartRequired = true;
        const output = await (options.runHelper ?? runHelper)(
          options.helperPath,
          ["request-screen-recording"],
          { env, timeout: 60_000, maxBuffer: 4096, detached: false },
        );
        const result = JSON.parse(output);
        if (
          result?.version !== 1 ||
          result?.requested !== true ||
          typeof result?.screenRecording !== "boolean"
        ) {
          throw new Error("Invalid screen recording permission helper response");
        }
      }
      return status();
    } catch (error) {
      return status(message(error));
    }
  }

  return {
    status,
    request(kind) {
      validateKind(kind);
      const existing = requests.get(kind);
      if (existing) return existing;
      const pending = requestPermission(kind).finally(() => requests.delete(kind));
      requests.set(kind, pending);
      return pending;
    },
    async openSettings(kind) {
      validateKind(kind);
      if (options.platform !== "darwin") throw new Error("Computer use permissions require macOS");
      await options.openExternal(SETTINGS[kind]);
    },
  };
}
