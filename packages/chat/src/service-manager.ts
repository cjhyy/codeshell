import { execFile as nodeExecFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

export interface GatewayServiceOptions {
  configPath: string;
  platform?: NodeJS.Platform;
  home?: string;
  executable?: string;
  cliPath?: string;
  run?: (command: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;
}

export interface GatewayServiceStatus {
  installed: boolean;
  running: boolean;
  definitionPath?: string;
  detail?: string;
}

/** Install the gateway as a per-user launchd/systemd/Task Scheduler service. */
export class GatewayServiceManager {
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly executable: string;
  private readonly cliPath: string;
  private readonly run: NonNullable<GatewayServiceOptions["run"]>;

  constructor(private readonly options: GatewayServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.home = resolve(options.home ?? process.env.HOME ?? homedir());
    this.executable = resolve(options.executable ?? process.execPath);
    this.cliPath = resolve(options.cliPath ?? process.argv[1] ?? "");
    this.run = options.run ?? ((command, args) => execFileAsync(command, args));
  }

  async install(): Promise<GatewayServiceStatus> {
    if (this.platform === "darwin") return this.installLaunchd();
    if (this.platform === "linux") return this.installSystemd();
    if (this.platform === "win32") return this.installTaskScheduler();
    throw new Error(`不支持的服务平台：${this.platform}`);
  }

  async uninstall(): Promise<GatewayServiceStatus> {
    if (this.platform === "darwin") {
      const path = this.launchdPath();
      await this.run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, path]).catch(
        () => undefined,
      );
      await rm(path, { force: true });
      return { installed: false, running: false, definitionPath: path };
    }
    if (this.platform === "linux") {
      const path = this.systemdPath();
      await this.run("systemctl", ["--user", "disable", "--now", "codeshell-chat.service"]).catch(
        () => undefined,
      );
      await rm(path, { force: true });
      await this.run("systemctl", ["--user", "daemon-reload"]);
      return { installed: false, running: false, definitionPath: path };
    }
    if (this.platform === "win32") {
      await this.run("schtasks.exe", ["/Delete", "/TN", "CodeShell Chat Gateway", "/F"]).catch(
        () => undefined,
      );
      return { installed: false, running: false };
    }
    throw new Error(`不支持的服务平台：${this.platform}`);
  }

  async status(): Promise<GatewayServiceStatus> {
    if (this.platform === "darwin") {
      const path = this.launchdPath();
      const installed = await fileExists(path);
      if (!installed) return { installed: false, running: false, definitionPath: path };
      const result = await this.run("launchctl", [
        "print",
        `gui/${process.getuid?.() ?? 0}/com.cjhyy.codeshell.chat-gateway`,
      ]).catch((error) => ({ stderr: String(error) }));
      return {
        installed: true,
        running: !result.stderr,
        definitionPath: path,
        ...(result.stderr ? { detail: result.stderr } : {}),
      };
    }
    if (this.platform === "linux") {
      const path = this.systemdPath();
      const installed = await fileExists(path);
      if (!installed) return { installed: false, running: false, definitionPath: path };
      const result = await this.run("systemctl", ["--user", "is-active", "codeshell-chat.service"])
        .then(({ stdout }) => ({ running: stdout?.trim() === "active", detail: stdout?.trim() }))
        .catch((error) => ({ running: false, detail: String(error) }));
      return { installed: true, definitionPath: path, ...result };
    }
    if (this.platform === "win32") {
      const result = await this.run("schtasks.exe", [
        "/Query",
        "/TN",
        "CodeShell Chat Gateway",
        "/FO",
        "LIST",
      ]).catch((error) => ({ stdout: "", stderr: String(error) }));
      const installed = !result.stderr;
      return {
        installed,
        running: installed && /Running/i.test(result.stdout ?? ""),
        ...(result.stderr ? { detail: result.stderr } : {}),
      };
    }
    throw new Error(`不支持的服务平台：${this.platform}`);
  }

  private async installLaunchd(): Promise<GatewayServiceStatus> {
    const path = this.launchdPath();
    const logDir = join(this.home, ".code-shell", "im-gateway", "logs");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await writeOwnerFile(
      path,
      renderLaunchdService({
        executable: this.executable,
        cliPath: this.cliPath,
        configPath: resolve(this.options.configPath),
        stdoutPath: join(logDir, "gateway.log"),
        stderrPath: join(logDir, "gateway.error.log"),
      }),
    );
    await this.run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, path]).catch(
      () => undefined,
    );
    await this.run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, path]);
    return { installed: true, running: true, definitionPath: path };
  }

  private async installSystemd(): Promise<GatewayServiceStatus> {
    const path = this.systemdPath();
    await writeOwnerFile(
      path,
      renderSystemdService({
        executable: this.executable,
        cliPath: this.cliPath,
        configPath: resolve(this.options.configPath),
      }),
    );
    await this.run("systemctl", ["--user", "daemon-reload"]);
    await this.run("systemctl", ["--user", "enable", "--now", "codeshell-chat.service"]);
    return { installed: true, running: true, definitionPath: path };
  }

  private async installTaskScheduler(): Promise<GatewayServiceStatus> {
    const command = windowsCommand([
      this.executable,
      this.cliPath,
      "--config",
      resolve(this.options.configPath),
    ]);
    await this.run("schtasks.exe", [
      "/Create",
      "/TN",
      "CodeShell Chat Gateway",
      "/TR",
      command,
      "/SC",
      "ONLOGON",
      "/RL",
      "LIMITED",
      "/F",
    ]);
    await this.run("schtasks.exe", ["/Run", "/TN", "CodeShell Chat Gateway"]);
    return { installed: true, running: true };
  }

  private launchdPath(): string {
    return join(this.home, "Library", "LaunchAgents", "com.cjhyy.codeshell.chat-gateway.plist");
  }

  private systemdPath(): string {
    return join(this.home, ".config", "systemd", "user", "codeshell-chat.service");
  }
}

export function renderLaunchdService(input: {
  executable: string;
  cliPath: string;
  configPath: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const args = [input.executable, input.cliPath, "--config", input.configPath]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cjhyy.codeshell.chat-gateway</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdService(input: {
  executable: string;
  cliPath: string;
  configPath: string;
}): string {
  return `[Unit]
Description=CodeShell Chat Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(input.executable)} ${systemdQuote(input.cliPath)} --config ${systemdQuote(input.configPath)}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.code-shell

[Install]
WantedBy=default.target
`;
}

async function writeOwnerFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { encoding: "utf-8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsCommand(args: string[]): string {
  return args.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(" ");
}
