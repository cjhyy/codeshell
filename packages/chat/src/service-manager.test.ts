import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayServiceManager,
  renderLaunchdService,
  renderSystemdService,
} from "./service-manager.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gateway service manager", () => {
  test("renders escaped launchd and hardened systemd definitions", () => {
    expect(
      renderLaunchdService({
        executable: "/opt/A&B/node",
        cliPath: "/app/chat.js",
        configPath: "/tmp/config.json",
        stdoutPath: "/tmp/out.log",
        stderrPath: "/tmp/err.log",
      }),
    ).toContain("/opt/A&amp;B/node");
    const unit = renderSystemdService({
      executable: "/usr/bin/node",
      cliPath: "/opt/code shell/chat.js",
      configPath: "/home/me/.code-shell/im-gateway/config.json",
    });
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/code shell/chat.js"');
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ReadWritePaths=%h/.code-shell");
  });

  test("installs and enables a user systemd unit without a shell", async () => {
    const home = tempRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = new GatewayServiceManager({
      configPath: join(home, "config.json"),
      platform: "linux",
      home,
      executable: "/usr/bin/node",
      cliPath: "/opt/codeshell/chat.js",
      run: async (command, args) => {
        calls.push({ command, args });
        return {};
      },
    });
    const status = await manager.install();
    expect(status).toMatchObject({ installed: true, running: true });
    expect(readFileSync(status.definitionPath!, "utf-8")).toContain(
      'ExecStart="/usr/bin/node" "/opt/codeshell/chat.js"',
    );
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      {
        command: "systemctl",
        args: ["--user", "enable", "--now", "codeshell-chat.service"],
      },
    ]);
  });

  test("creates a Windows ONLOGON task with argument-array execution", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const manager = new GatewayServiceManager({
      configPath: "C:\\Users\\me\\config.json",
      platform: "win32",
      home: tempRoot(),
      executable: "C:\\Program Files\\node.exe",
      cliPath: "C:\\CodeShell\\chat.js",
      run: async (command, args) => {
        calls.push({ command, args });
        return {};
      },
    });
    await manager.install();
    expect(calls[0]?.command).toBe("schtasks.exe");
    expect(calls[0]?.args).toContain("ONLOGON");
    expect(calls[0]?.args.join(" ")).toContain("CodeShell Chat Gateway");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codeshell-chat-service-"));
  roots.push(root);
  return root;
}
