import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PanelAppProcessService,
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
    const path = join(root, name);
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
});
