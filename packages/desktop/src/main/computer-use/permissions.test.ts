import { describe, expect, test } from "bun:test";
import {
  createComputerUsePermissionsController,
  resolveComputerUsePermissionsHelper,
  type ComputerUsePermissionKind,
  type ComputerUsePermissionsOptions,
  type PermissionHelperOptions,
} from "./permissions.js";

const HELPER = "/trusted/CodeShell Computer Use.app/Contents/MacOS/codeshell-computer-use";

function harness(overrides: Partial<ComputerUsePermissionsOptions> = {}) {
  const state = { accessibility: false, screenRecording: false };
  const urls: string[] = [];
  const executions: { path: string; args: string[]; options: PermissionHelperOptions }[] = [];
  const controller = createComputerUsePermissionsController({
    platform: "darwin",
    helperPath: HELPER,
    isExecutable: () => true,
    parentEnv: {
      HOME: "/isolated/home",
      TMPDIR: "/isolated/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/untrusted/bin",
      OPENAI_API_KEY: "must-not-leak",
      CUA_API_KEY: "must-not-leak-either",
      DYLD_INSERT_LIBRARIES: "/untrusted/injection.dylib",
      CUA_DRIVER_PERMISSION_MODE: "unrestricted",
    },
    openExternal: async (url) => {
      urls.push(url);
    },
    runHelper: async (path, args, options) => {
      executions.push({ path, args, options });
      return JSON.stringify({ version: 1, requested: args[1] !== "status", ...state });
    },
    ...overrides,
  });
  return { controller, state, urls, executions };
}

describe("Computer Use helper permission controller", () => {
  test("status queries the separate helper without requesting permissions or opening settings", async () => {
    const h = harness();
    expect(await h.controller.status()).toEqual({
      supported: true,
      accessibility: "denied",
      screenRecording: "denied",
      screenRequestAvailable: true,
      restartRequired: false,
    });
    expect(h.executions.map((x) => x.args)).toEqual([["launch", "status"]]);
    expect(h.urls).toEqual([]);
  });

  test.each(["accessibility", "screenRecording"] as const)(
    "%s prompts only on an explicit request",
    async (kind) => {
      const h = harness();
      const status = await h.controller.request(kind);
      expect(h.executions.map((x) => x.args)).toEqual([
        ["launch", "status"],
        ["launch", kind === "accessibility" ? "request-accessibility" : "request-screen-recording"],
      ]);
      expect(status.restartRequired).toBe(true);
      expect(h.urls).toEqual([]);
    },
  );

  test("already granted helper permissions never prompt again", async () => {
    const h = harness();
    h.state.accessibility = true;
    h.state.screenRecording = true;
    await h.controller.request("accessibility");
    expect((await h.controller.request("screenRecording")).restartRequired).toBe(false);
    expect(h.executions.every((x) => x.args[1] === "status")).toBe(true);
  });

  test("both checks and requests use fixed operations and a credential-free environment", async () => {
    const h = harness();
    await h.controller.request("screenRecording");
    for (const execution of h.executions) {
      expect(execution.path).toBe(HELPER);
      expect(execution.options.env).toEqual({
        HOME: "/isolated/home",
        TMPDIR: "/isolated/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
      });
      expect(execution.options.detached).toBe(false);
      expect(execution.options.maxBuffer).toBe(4096);
    }
    expect(h.executions.map((x) => x.options.timeout)).toEqual([15_000, 60_000]);
  });

  test("the helper grant is authoritative even when the host has no grant", async () => {
    const h = harness({
      runHelper: async (_path, args) =>
        JSON.stringify({
          version: 1,
          requested: args[1] !== "status",
          accessibility: true,
          screenRecording: true,
        }),
    });
    const status = await h.controller.status();
    expect(status.accessibility).toBe("granted");
    expect(status.screenRecording).toBe("granted");
    expect(status.error).toBeUndefined();
  });

  test.each(["accessibility", "screenRecording"] as const)(
    "new %s grants invalidate the running daemon",
    async (kind) => {
      const h = harness();
      await h.controller.status();
      h.state[kind] = true;
      expect((await h.controller.status()).restartRequired).toBe(true);
      h.state[kind] = false;
      expect((await h.controller.status()).restartRequired).toBe(true);
    },
  );

  test("helper failures remain unknown instead of falling back to host permissions", async () => {
    const h = harness({
      runHelper: async () => {
        throw new Error("LaunchServices unavailable");
      },
    });
    const status = await h.controller.status();
    expect(status.accessibility).toBe("unknown");
    expect(status.screenRecording).toBe("unknown");
    expect(status.error).toContain("LaunchServices unavailable");
  });

  test.each([undefined, false])(
    "a missing or non-executable helper fails closed: %s",
    async (present) => {
      const h = harness(
        present === undefined ? { helperPath: undefined } : { isExecutable: () => false },
      );
      const status = await h.controller.request("accessibility");
      expect(status.screenRequestAvailable).toBe(false);
      expect(status.error).toContain("helper is unavailable");
      expect(status.restartRequired).toBe(false);
      expect(h.executions).toEqual([]);
    },
  );

  test.each([
    "not json",
    "null",
    JSON.stringify({ version: 2, requested: false, accessibility: true, screenRecording: true }),
    JSON.stringify({ version: 1, requested: true, accessibility: true, screenRecording: true }),
    JSON.stringify({
      version: 1,
      requested: false,
      accessibility: true,
      screenRecording: "granted",
    }),
    JSON.stringify({ version: 1, requested: false, screenRecording: true }),
  ])("invalid status output never grants permission: %s", async (output) => {
    const h = harness({ runHelper: async () => output });
    const status = await h.controller.status();
    expect(status.accessibility).toBe("unknown");
    expect(status.screenRecording).toBe("unknown");
    expect(status.error).toBeDefined();
  });

  test("interrupted explicit requests mark restart and never manufacture a grant", async () => {
    const h = harness({
      runHelper: async (_path, args) => {
        if (args[1] !== "status") throw new Error("permission request interrupted");
        return JSON.stringify({
          version: 1,
          requested: false,
          accessibility: false,
          screenRecording: false,
        });
      },
    });
    const status = await h.controller.request("screenRecording");
    expect(status.restartRequired).toBe(true);
    expect(status.screenRecording).toBe("unknown");
    expect(status.error).toContain("interrupted");
  });

  test("overlapping status reads and duplicate requests share one launch each", async () => {
    const pending: Array<(output: string) => void> = [];
    const h = harness({ runHelper: async () => new Promise((resolve) => pending.push(resolve)) });
    const read = h.controller.status();
    expect(h.controller.status()).toBe(read);
    const first = h.controller.request("screenRecording");
    expect(h.controller.request("screenRecording")).toBe(first);
    expect(pending).toHaveLength(1);
    pending[0]!(
      JSON.stringify({
        version: 1,
        requested: false,
        accessibility: false,
        screenRecording: false,
      }),
    );
    await read;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pending).toHaveLength(2);
    pending[1]!(
      JSON.stringify({ version: 1, requested: true, accessibility: false, screenRecording: false }),
    );
    await first;
  });

  test("settings URLs and request names are restricted", async () => {
    const h = harness();
    await h.controller.openSettings("accessibility");
    await h.controller.openSettings("screenRecording");
    expect(h.urls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
    const invalid = "https://untrusted.invalid" as ComputerUsePermissionKind;
    expect(() => h.controller.request(invalid)).toThrow("Unknown computer use permission");
    await expect(h.controller.openSettings(invalid)).rejects.toThrow(
      "Unknown computer use permission",
    );
    expect(h.executions).toEqual([]);
  });

  test.each(["linux", "win32"] as const)("%s never launches macOS helpers", async (platform) => {
    const h = harness({ platform });
    expect(await h.controller.status()).toEqual({
      supported: false,
      accessibility: "unsupported",
      screenRecording: "unsupported",
      screenRequestAvailable: false,
      restartRequired: false,
    });
    await expect(h.controller.request("accessibility")).rejects.toThrow("require macOS");
    await expect(h.controller.openSettings("screenRecording")).rejects.toThrow("require macOS");
    expect(h.executions).toEqual([]);
  });
});

describe("Computer Use permission helper placement", () => {
  test("packaged permissions use the same independent app as the daemon", () => {
    expect(
      resolveComputerUsePermissionsHelper({
        isPackaged: true,
        appPath: "/App/Contents/Resources/app.asar",
        resourcesPath: "/App/Contents/Resources",
      }),
    ).toBe(
      "/App/Contents/Library/CodeShell Computer Use.app/Contents/MacOS/codeshell-computer-use",
    );
  });
  test("development uses this checkout's helper bundle", () => {
    expect(
      resolveComputerUsePermissionsHelper({
        isPackaged: false,
        appPath: "/worktree/packages/desktop",
        resourcesPath: "/electron/resources",
      }),
    ).toBe(
      "/worktree/packages/desktop/out/native/CodeShell Computer Use.app/Contents/MacOS/codeshell-computer-use",
    );
  });
});
