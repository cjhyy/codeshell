import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { computerUseBundlePaths } from "./cua-driver-host.js";
import type {
  ComputerUsePermissionKind,
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
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Main-owned helper from this installation, never from renderer input. */
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
  return computerUseBundlePaths(options)!.helperPath;
}

function runHelper(
  path: string,
  args: string[],
  options: PermissionHelperOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // The bridge launches a separate application through LaunchServices. The
    // permission read/request occurs there, under the same identity as actions.
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

/** Status probes never prompt. Only explicit settings requests may ask the OS. */
export function createComputerUsePermissionsController(
  options: ComputerUsePermissionsOptions,
): ComputerUsePermissionsController {
  let restartRequired = false;
  let previous: Pick<ComputerUsePermissionStatus, "accessibility" | "screenRecording"> | undefined;
  let reading: Promise<ComputerUsePermissionStatus> | undefined;
  const requests = new Map<ComputerUsePermissionKind, Promise<ComputerUsePermissionStatus>>();
  const executable = options.isExecutable ?? isExecutable;

  function available(): boolean {
    return !!options.helperPath && executable(options.helperPath);
  }

  async function read(operation: string, error?: string): Promise<ComputerUsePermissionStatus> {
    if (options.platform !== "darwin") {
      return {
        supported: false,
        accessibility: "unsupported",
        screenRecording: "unsupported",
        screenRequestAvailable: false,
        restartRequired: false,
      };
    }
    const result: ComputerUsePermissionStatus = {
      supported: true,
      accessibility: "unknown",
      screenRecording: "unknown",
      screenRequestAvailable: available(),
      restartRequired,
      ...(error ? { error } : {}),
    };
    try {
      if (!result.screenRequestAvailable) {
        throw new Error("CodeShell Computer Use helper is unavailable; rebuild CodeShell");
      }
      const parentEnv = options.parentEnv ?? process.env;
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"]) {
        if (typeof parentEnv[key] === "string") env[key] = parentEnv[key];
      }
      const requested = operation !== "status";
      // Even an interrupted native prompt can change the OS grant.
      if (requested) restartRequired = true;
      const output = await (options.runHelper ?? runHelper)(
        options.helperPath!,
        ["launch", operation],
        { env, timeout: requested ? 60_000 : 15_000, maxBuffer: 4096, detached: false },
      );
      const response = JSON.parse(output);
      if (
        response?.version !== 1 ||
        response?.requested !== requested ||
        typeof response?.accessibility !== "boolean" ||
        typeof response?.screenRecording !== "boolean"
      ) {
        throw new Error("Invalid CodeShell Computer Use permission response");
      }
      result.accessibility = response.accessibility ? "granted" : "denied";
      result.screenRecording = response.screenRecording ? "granted" : "denied";
      if (
        previous &&
        ((previous.accessibility === "denied" && result.accessibility === "granted") ||
          (previous.screenRecording === "denied" && result.screenRecording === "granted"))
      ) {
        restartRequired = true;
      }
      previous = { accessibility: result.accessibility, screenRecording: result.screenRecording };
    } catch (cause) {
      result.error = [error, message(cause)].filter(Boolean).join("; ");
    }
    result.restartRequired = restartRequired;
    return result;
  }

  function status(): Promise<ComputerUsePermissionStatus> {
    if (reading) return reading;
    const pending = read("status").finally(() => {
      if (reading === pending) reading = undefined;
    });
    reading = pending;
    return pending;
  }

  async function requestPermission(kind: ComputerUsePermissionKind) {
    const before = await status();
    if (!before.supported) throw new Error("Computer use permissions require macOS");
    if (before[kind] === "granted" || !before.screenRequestAvailable) return before;
    return read(kind === "accessibility" ? "request-accessibility" : "request-screen-recording");
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
