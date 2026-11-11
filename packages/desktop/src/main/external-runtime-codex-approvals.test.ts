/**
 * Fixtures follow `codex app-server generate-ts` (codex-cli 0.162.0):
 * CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams,
 * PermissionsRequestApprovalParams.
 */
import { describe, expect, test } from "bun:test";
import { codexNativeApprovalPresentation } from "./external-runtime-codex-approvals.js";

const routing = { threadId: "t", turnId: "u", itemId: "i", startedAtMs: 1 };

describe("codexNativeApprovalPresentation", () => {
  test("a command names the command, its cwd and reason, without routing ids", () => {
    expect(
      codexNativeApprovalPresentation("item/commandExecution/requestApproval", {
        ...routing,
        kind: "command",
        approvalId: null,
        environmentId: null,
        command: "npm test",
        cwd: "/repo",
        reason: "跑测试",
      }),
    ).toEqual({
      description: "Codex 想执行命令",
      args: { command: "npm test", cwd: "/repo", reason: "跑测试" },
    });
  });

  test("input to a running terminal is labelled so, not as a new command", () => {
    expect(
      codexNativeApprovalPresentation("item/commandExecution/requestApproval", {
        ...routing,
        kind: "writeStdin",
        approvalId: "cb-1",
        environmentId: null,
        command: "python repl.py",
      }),
    ).toEqual({
      description: "Codex 想向正在运行的终端输入",
      args: { command: "python repl.py" },
    });
  });

  test("a managed-network approval names the host and protocol", () => {
    expect(
      codexNativeApprovalPresentation("item/commandExecution/requestApproval", {
        ...routing,
        kind: "command",
        environmentId: null,
        reason: "network access",
        networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
        command: "npm install",
      }),
    ).toEqual({
      description: "Codex 想访问网络：registry.npmjs.org（https）",
      args: {
        command: "npm install",
        network: { host: "registry.npmjs.org", protocol: "https" },
        reason: "network access",
      },
    });
  });

  test("a file change lists the files its item announced", () => {
    expect(
      codexNativeApprovalPresentation(
        "item/fileChange/requestApproval",
        { ...routing, reason: null, grantRoot: "/repo" },
        [
          { path: "/repo/a.ts", kind: "update", movePath: "/repo/b.ts" },
          { path: "/repo/new.ts", kind: "add" },
        ],
      ),
    ).toEqual({
      description: "Codex 想修改文件",
      args: { files: ["update /repo/a.ts → /repo/b.ts", "add /repo/new.ts"], grantRoot: "/repo" },
    });
  });

  test("a file change with no known files sends the owner to the desktop diff", () => {
    expect(
      codexNativeApprovalPresentation("item/fileChange/requestApproval", { ...routing }),
    ).toEqual({ description: "Codex 想修改文件（打开桌面查看改动）", args: {} });
  });

  test("a permissions request shows the requested profile (an object, not a list)", () => {
    expect(
      codexNativeApprovalPresentation("item/permissions/requestApproval", {
        ...routing,
        environmentId: null,
        cwd: "/repo",
        reason: "needs network",
        permissions: { network: { enabled: true }, fileSystem: null },
      }),
    ).toEqual({
      description: "Codex 想获得额外权限（仅本轮）",
      args: { network: { enabled: true }, cwd: "/repo", reason: "needs network" },
    });
  });

  test("an unknown approval shows its params without routing ids", () => {
    expect(
      codexNativeApprovalPresentation("item/other/requestApproval", { ...routing, detail: "x" }),
    ).toEqual({
      description: "Codex 请求批准（item/other/requestApproval）",
      args: { detail: "x" },
    });
  });
});
