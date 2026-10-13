import { describe, expect, test } from "bun:test";
import {
  createComputerUsePermissionsController,
  resolveComputerUsePermissionsHelper,
  type ComputerUsePermissionKind,
  type ComputerUsePermissionsOptions,
  type PermissionHelperOptions,
} from "./permissions.js";

function harness(overrides: Partial<ComputerUsePermissionsOptions> = {}) {
  const state = { accessibility: false, screenRecording: "denied" };
  const prompts: boolean[] = [];
  const urls: string[] = [];
  const executions: { path: string; args: string[]; options: PermissionHelperOptions }[] = [];
  const controller = createComputerUsePermissionsController({
    platform: "darwin",
    helperPath: "/trusted/resources/computer-use/codeshell-permissions",
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
    },
    systemPreferences: {
      isTrustedAccessibilityClient: (prompt) => {
        prompts.push(prompt);
        return state.accessibility;
      },
      getMediaAccessStatus: (kind) => {
        expect(kind).toBe("screen");
        return state.screenRecording;
      },
    },
    openExternal: async (url) => {
      urls.push(url);
    },
    runHelper: async (path, args, options) => {
      executions.push({ path, args, options });
      return JSON.stringify({ version: 1, requested: true, screenRecording: false });
    },
    ...overrides,
  });
  return { controller, state, prompts, urls, executions };
}

describe("Computer Use macOS permission controller", () => {
  test("reading status is read-only and does not launch a helper or open settings", async () => {
    const h = harness();
    expect(await h.controller.status()).toEqual({
      supported: true,
      accessibility: "denied",
      screenRecording: "denied",
      screenRequestAvailable: true,
      restartRequired: false,
    });
    expect(h.prompts).toEqual([false]);
    expect(h.executions).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  test("Accessibility is prompted only by an explicit request", async () => {
    const h = harness();
    await h.controller.request("accessibility");
    expect(h.prompts).toEqual([false, true, false]);
    expect(h.executions).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  test("granted permissions never prompt again", async () => {
    const h = harness();
    h.state.accessibility = true;
    h.state.screenRecording = "granted";
    await h.controller.request("accessibility");
    const status = await h.controller.request("screenRecording");
    expect(status.restartRequired).toBe(false);
    expect(h.prompts).toEqual([false, false]);
    expect(h.executions).toEqual([]);
  });

  test("screen requests use the fixed direct-child operation and a credential-free environment", async () => {
    const h = harness();
    const status = await h.controller.request("screenRecording");
    expect(h.executions).toEqual([
      {
        path: "/trusted/resources/computer-use/codeshell-permissions",
        args: ["request-screen-recording"],
        options: {
          env: {
            HOME: "/isolated/home",
            TMPDIR: "/isolated/tmp",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
          },
          timeout: 60_000,
          maxBuffer: 4096,
          detached: false,
        },
      },
    ]);
    expect(status.screenRecording).toBe("denied");
    expect(status.restartRequired).toBe(true);
    expect(status.error).toBeUndefined();
  });

  test("a helper grant cannot override a still-denied host status", async () => {
    const h = harness({
      runHelper: async () => JSON.stringify({ version: 1, requested: true, screenRecording: true }),
    });
    const status = await h.controller.request("screenRecording");
    expect(status.screenRecording).toBe("denied");
    expect(status.restartRequired).toBe(true);
  });

  test("new grants seen after System Settings require a full app restart", async () => {
    const h = harness();
    await h.controller.status();
    h.state.screenRecording = "granted";
    expect((await h.controller.status()).restartRequired).toBe(true);
    h.state.screenRecording = "denied";
    expect((await h.controller.status()).restartRequired).toBe(true);
  });

  test("Accessibility grant changes also invalidate the daemon's cached status", async () => {
    const h = harness();
    await h.controller.status();
    h.state.accessibility = true;
    expect((await h.controller.status()).restartRequired).toBe(true);
  });

  test.each(["not-determined", "restricted", "denied"])(
    "screen status %s remains denied",
    async (screenStatus) => {
      const h = harness();
      h.state.screenRecording = screenStatus;
      expect((await h.controller.status()).screenRecording).toBe("denied");
      expect(h.executions).toEqual([]);
    },
  );

  test("unknown OS screen status is never treated as authorization", async () => {
    const h = harness();
    h.state.screenRecording = "future-status";
    expect((await h.controller.status()).screenRecording).toBe("unknown");
  });

  test("status errors remain unknown and expose a useful error", async () => {
    const h = harness({
      systemPreferences: {
        isTrustedAccessibilityClient: () => {
          throw new Error("AX unavailable");
        },
        getMediaAccessStatus: () => {
          throw new Error("TCC unavailable");
        },
      },
    });
    const status = await h.controller.status();
    expect(status.accessibility).toBe("unknown");
    expect(status.screenRecording).toBe("unknown");
    expect(status.error).toContain("AX unavailable");
    expect(status.error).toContain("TCC unavailable");
    expect(h.executions).toEqual([]);
  });

  test("a missing native helper never triggers another permission mechanism", async () => {
    const h = harness({ helperPath: undefined });
    const status = await h.controller.request("screenRecording");
    expect(status.screenRequestAvailable).toBe(false);
    expect(status.error).toContain("helper is unavailable");
    expect(status.restartRequired).toBe(false);
    expect(h.executions).toEqual([]);
    expect(h.prompts).toEqual([false, false]);
  });

  test("a non-executable helper fails closed", async () => {
    const h = harness({ isExecutable: () => false });
    expect((await h.controller.request("screenRecording")).error).toContain("rebuild CodeShell");
    expect(h.executions).toEqual([]);
  });

  test("helper failures preserve denial and expose errors", async () => {
    const h = harness({
      runHelper: async () => {
        throw new Error("permission helper timed out");
      },
    });
    const status = await h.controller.request("screenRecording");
    expect(status.screenRecording).toBe("denied");
    expect(status.error).toBe("permission helper timed out");
    expect(status.restartRequired).toBe(true);
  });

  test.each([
    "not json",
    "null",
    JSON.stringify({ version: 2, requested: true, screenRecording: true }),
    JSON.stringify({ version: 1, requested: false, screenRecording: true }),
    JSON.stringify({ version: 1, requested: true, screenRecording: "granted" }),
  ])("invalid helper output never grants permission: %s", async (output) => {
    const h = harness({ runHelper: async () => output });
    const status = await h.controller.request("screenRecording");
    expect(status.screenRecording).toBe("denied");
    expect(status.error).toBeDefined();
  });

  test("overlapping screen requests share one pending native prompt", async () => {
    let release!: (output: string) => void;
    let calls = 0;
    const h = harness({
      runHelper: async () => {
        calls++;
        return new Promise((resolve) => (release = resolve));
      },
    });
    const first = h.controller.request("screenRecording");
    const second = h.controller.request("screenRecording");
    expect(first).toBe(second);
    await Promise.resolve();
    expect(calls).toBe(1);
    release(JSON.stringify({ version: 1, requested: true, screenRecording: false }));
    await first;
  });

  test("settings are opened only from a fixed allowlist", async () => {
    const h = harness();
    await h.controller.openSettings("accessibility");
    await h.controller.openSettings("screenRecording");
    expect(h.urls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]);
    expect(h.executions).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test("untrusted runtime permission names cannot become commands or settings URLs", async () => {
    const h = harness();
    const invalid = "https://untrusted.invalid" as ComputerUsePermissionKind;
    expect(() => h.controller.request(invalid)).toThrow("Unknown computer use permission");
    await expect(h.controller.openSettings(invalid)).rejects.toThrow(
      "Unknown computer use permission",
    );
    expect(h.executions).toEqual([]);
    expect(h.urls).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  test.each(["linux", "win32"] as const)("%s never calls macOS APIs", async (platform) => {
    const h = harness({ platform });
    expect(await h.controller.status()).toEqual({
      supported: false,
      accessibility: "unsupported",
      screenRecording: "unsupported",
      screenRequestAvailable: false,
      restartRequired: false,
    });
    await expect(h.controller.request("accessibility")).rejects.toThrow("require macOS");
    await expect(h.controller.request("screenRecording")).rejects.toThrow("require macOS");
    await expect(h.controller.openSettings("screenRecording")).rejects.toThrow("require macOS");
    expect(h.executions).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.urls).toEqual([]);
  });
});

describe("Computer Use permission helper placement", () => {
  test("packaged helper stays outside ASAR", () => {
    expect(
      resolveComputerUsePermissionsHelper({
        isPackaged: true,
        appPath: "/Applications/CodeShell.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/CodeShell.app/Contents/Resources",
      }),
    ).toBe("/Applications/CodeShell.app/Contents/Resources/computer-use/codeshell-permissions");
  });

  test("development helper comes from this checkout's native build output", () => {
    expect(
      resolveComputerUsePermissionsHelper({
        isPackaged: false,
        appPath: "/worktree/packages/desktop",
        resourcesPath: "/electron/resources",
      }),
    ).toBe("/worktree/packages/desktop/out/native/codeshell-permissions");
  });
});
