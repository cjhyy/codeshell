import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelAppProcessService,
  panelExecutableDirectories,
  panelProcessInfo,
  resolvePanelExecutable,
  type PanelProcessOwner,
} from "./panel-app-process-service.js";

describe("PanelAppProcessService", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function executable(name: string, body: string): string {
    root ||= mkdtempSync(join(tmpdir(), "panel-process-"));
    return executableAt(root, name, body);
  }

  function executableAt(directory: string, name: string, body: string): string {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("resolves only simple executable names from PATH", async () => {
    const path = executable("demo-tool", 'printf "ok\\n"');
    expect(await resolvePanelExecutable("demo-tool", { env: { PATH: root } })).toBe(
      realpathSync(path),
    );
    expect(await resolvePanelExecutable("missing-tool", { env: { PATH: root } })).toBeNull();
    await expect(resolvePanelExecutable("../demo-tool", { env: { PATH: root } })).rejects.toThrow(
      /invalid executable name/,
    );
  });

  test("resolves Host-managed executables outside the inherited PATH", async () => {
    const path = executable("managed-tool", 'printf "ok\\n"');
    expect(
      await resolvePanelExecutable("managed-tool", {
        env: { PATH: "" },
        extraPathDirectories: [root],
      }),
    ).toBe(realpathSync(path));
  });

  test("reports Linux libc without exposing other process details", () => {
    expect(panelProcessInfo("linux", "x64", { header: { glibcVersionRuntime: "2.39" } })).toEqual({
      platform: "linux",
      arch: "x64",
      libc: "glibc",
    });
    expect(panelProcessInfo("linux", "arm64", { header: {} })).toEqual({
      platform: "linux",
      arch: "arm64",
      libc: "musl",
    });
    expect(panelProcessInfo("darwin", "arm64", {})).toEqual({
      platform: "darwin",
      arch: "arm64",
    });
  });

  test("adds Windows package-manager links without relying on the startup PATH", () => {
    expect(
      panelExecutableDirectories("C:\\CodeShell\\bin", {
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\Mimi\\AppData\\Local" },
      }),
    ).toEqual([
      "C:\\CodeShell\\bin",
      "C:\\Users\\Mimi\\AppData\\Local/Microsoft/WinGet/Links",
      "C:\\Users\\Mimi\\AppData\\Local/Microsoft/WindowsApps",
    ]);
  });

  test("adds macOS and Linux executable directories in Host-first order", () => {
    expect(
      panelExecutableDirectories("/managed/bin", {
        platform: "darwin",
        home: "/Users/Mimi",
      }),
    ).toEqual(["/managed/bin", "/Users/Mimi/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
    expect(
      panelExecutableDirectories("/managed/bin", {
        platform: "linux",
        home: "/home/mimi",
      }),
    ).toEqual([
      "/managed/bin",
      "/home/mimi/.local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/usr/local/bin",
    ]);
    expect(
      panelExecutableDirectories("/usr/local/bin", {
        platform: "darwin",
        home: "",
      }),
    ).toEqual(["/usr/local/bin", "/opt/homebrew/bin"]);
  });

  test("keeps Host-known executable directories in the spawned PATH", async () => {
    root = mkdtempSync(join(tmpdir(), "panel-process-"));
    const home = join(root, "home");
    const localBin = join(home, ".local", "bin");
    const inheritedBin = join(root, "inherited", "bin");
    executableAt(localBin, "companion-tool", 'printf "companion-ok\\n"');
    executableAt(inheritedBin, "companion-tool", 'printf "inherited-wrong\\n"');
    executableAt(localBin, "primary-tool", "companion-tool");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let resolveExit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const owner: PanelProcessOwner = {
      guestId: 6,
      appId: "path-demo",
      appTitle: "Path Demo",
      revision: "r1",
      send: (event, payload) => {
        events.push({ event, payload });
        if (event === "process.exit") resolveExit();
      },
    };
    const service = new PanelAppProcessService({
      env: { PATH: inheritedBin },
      platform: "darwin",
      extraPathDirectories: () =>
        panelExecutableDirectories(join(root, "managed", "bin"), {
          platform: "darwin",
          home,
        }),
      confirmExecution: async () => true,
    });
    const found = await service.findExecutable(owner, { name: "primary-tool" });
    expect(found.available).toBe(true);
    const directory = await service.grantDirectory(owner, root);
    await service.start(owner, {
      executableHandle: found.handle,
      directoryHandle: directory.handle,
      args: [],
    });
    await exited;

    const output = events
      .filter((entry) => entry.event === "process.output")
      .map((entry) => entry.payload.text)
      .join("");
    expect(output).toContain("companion-ok");
    expect(output).not.toContain("inherited-wrong");
    expect(events.at(-1)?.payload.code).toBe(0);
  });

  test("runs argv without a shell and streams output to the owning guest", async () => {
    executable("demo-tool", 'printf "out:%s\\n" "$1"; printf "err\\n" >&2');
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let approvals = 0;
    let resolveExit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const owner: PanelProcessOwner = {
      guestId: 7,
      appId: "demo",
      appTitle: "Demo",
      revision: "r1",
      send: (event, payload) => {
        events.push({ event, payload });
        if (event === "process.exit") resolveExit();
      },
    };
    const service = new PanelAppProcessService({
      env: { PATH: root, SECRET_SHOULD_NOT_LEAK: "hidden" },
      confirmExecution: async () => {
        approvals += 1;
        return true;
      },
    });
    const found = await service.findExecutable(owner, { name: "demo-tool" });
    const directory = await service.grantDirectory(owner, root);
    await service.start(owner, {
      executableHandle: found.handle,
      directoryHandle: directory.handle,
      args: ["$(printf injected)"],
    });
    await exited;

    const output = events
      .filter((entry) => entry.event === "process.output")
      .map((entry) => entry.payload.text)
      .join("");
    expect(output).toContain("out:$(printf injected)");
    expect(output).toContain("err");
    expect(events.at(-1)?.event).toBe("process.exit");
    expect(approvals).toBe(1);
  });

  test("keeps executable and directory handles scoped to one guest", async () => {
    executable("demo-tool", 'printf "ok\\n"');
    const service = new PanelAppProcessService({
      env: { PATH: root },
      confirmExecution: async () => true,
    });
    const first: PanelProcessOwner = {
      guestId: 1,
      appId: "first",
      appTitle: "First",
      revision: "r1",
      send: () => undefined,
    };
    const second = { ...first, guestId: 2, appId: "second", appTitle: "Second" };
    const found = await service.findExecutable(first, { name: "demo-tool" });
    const directory = await service.grantDirectory(first, root);
    await expect(
      service.start(second, {
        executableHandle: found.handle,
        directoryHandle: directory.handle,
        args: [],
      }),
    ).rejects.toThrow(/belongs to another Panel App/);
  });

  test("passes sealed files only to their bound executable and cleans them on revoke", async () => {
    executable(
      "cookie-tool",
      'printf "flag:%s\\n" "$1"; { IFS= read -r first; IFS= read -r second; printf "cookie:%s\\n" "$second"; } < "$2"; printf "tail:%s\\n" "$3"',
    );
    executable("other-tool", 'printf "should-not-run\\n"');
    const secretFile = join(root, "cookies.txt");
    writeFileSync(
      secretFile,
      "# Netscape HTTP Cookie File\n.example.com\\tTRUE\\t/\\tTRUE\\t0\\tsid\\tcookie-secret\n",
      {
        mode: 0o600,
      },
    );
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    let resolveExit = (): void => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const owner: PanelProcessOwner = {
      guestId: 9,
      appId: "cookie-demo",
      appTitle: "Cookie Demo",
      revision: "r1",
      send: (event, payload) => {
        events.push({ event, payload });
        if (event === "process.exit") resolveExit();
      },
    };
    const service = new PanelAppProcessService({
      env: { PATH: root },
      confirmExecution: async () => true,
    });
    const executableGrant = await service.findExecutable(owner, { name: "cookie-tool" });
    const otherExecutable = await service.findExecutable(owner, { name: "other-tool" });
    const directory = await service.grantDirectory(owner, root);
    const sealed = await service.grantFileArgument(owner, {
      executableHandle: executableGrant.handle,
      argumentName: "--cookies",
      path: secretFile,
      cleanup: () => rmSync(secretFile, { force: true }),
    });
    expect(sealed).toEqual({ handle: expect.any(String) });
    expect(JSON.stringify(sealed)).not.toContain(secretFile);

    await expect(
      service.start(owner, {
        executableHandle: otherExecutable.handle,
        directoryHandle: directory.handle,
        fileArgumentHandles: [sealed.handle],
        args: [],
      }),
    ).rejects.toThrow(/bound to a different executable/);

    await service.start(owner, {
      executableHandle: executableGrant.handle,
      directoryHandle: directory.handle,
      fileArgumentHandles: [sealed.handle],
      args: ["last"],
    });
    await exited;
    const output = events
      .filter((entry) => entry.event === "process.output")
      .map((entry) => entry.payload.text)
      .join("");
    expect(output).toContain("flag:--cookies");
    expect(output).toContain("cookie:.example.com");
    expect(output).toContain("tail:last");
    expect(existsSync(secretFile)).toBe(true);

    service.revokeGuest(owner.guestId);
    expect(existsSync(secretFile)).toBe(false);
  });
});
