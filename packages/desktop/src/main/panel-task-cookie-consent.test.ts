import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";
import { taskCookieFromInput } from "../../../server/src/panels/task-cookies.js";

// Compile only the consent methods from the production bridge so the test keeps
// the real decision logic without importing Electron.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = ["confirmTaskCookie", "savedLoginAutoUse", "requirePermission"].map((name) =>
  declaration.members
    .find((node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)!
    .getText(parsed),
);
const compiled = ts.transpileModule(`class Bridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const REVISION = "a".repeat(64);
const input = {
  cookieArgument: {
    argumentName: "--cookies",
    credentialId: "panel-video-download__bilibili",
    url: "https://www.bilibili.com/video/BV1DFuE6tEqU/",
    revision: REVISION,
  },
};

function fixture(autoUseByAI: boolean | undefined, response = 1) {
  const prompts: string[] = [];
  const Bridge = runInNewContext(`${compiled}; Bridge`, {
    PanelBridgeError,
    taskCookieFromInput,
    URL,
    BrowserWindow: { fromId: () => ({ isDestroyed: () => false }) },
    dialog: {
      showMessageBox: async (_owner: unknown, options: { message: string }) => {
        prompts.push(options.message);
        return { response };
      },
    },
  });
  const bridge = new Bridge();
  const binding = {
    ownerWindowId: 1,
    projectPath: "/project",
    cwd: "/project",
    guest: { id: 7, isDestroyed: () => false },
    resource: {
      descriptor: {
        appId: "video-download",
        revision: "r1",
        title: "Mimi Download",
        permissions: ["credentials.cookies"],
      },
    },
  };
  Object.assign(bridge, {
    guests: new Map([[7, binding]]),
    options: {
      isWorkspaceTrusted: () => true,
      cookieCredentials: {
        taskCredentials: async () => [
          {
            id: "panel-video-download__bilibili",
            type: "cookie",
            label: "Bilibili 登录",
            ...(autoUseByAI === undefined ? {} : { autoUseByAI }),
          },
        ],
      },
    },
    getTaskCookieHost: () => ({
      check: async () => ({
        id: "panel-video-download__bilibili",
        label: "Bilibili 登录",
        domain: "bilibili.com",
        revision: REVISION,
      }),
    }),
    trustedWorkspaceRoot: async () => "/project",
    assertProjectBinding() {},
  });
  return { bridge, binding, prompts };
}

test("a saved login set to AI auto-use starts background tasks without a prompt", async () => {
  const { bridge, binding, prompts } = fixture(true);
  await bridge.confirmTaskCookie(binding, input, "yt-dlp");
  expect(prompts).toEqual([]);
});

test("a saved login without AI auto-use still asks before each background task", async () => {
  for (const flag of [false, undefined]) {
    const { bridge, binding, prompts } = fixture(flag, 1);
    await expect(bridge.confirmTaskCookie(binding, input, "yt-dlp")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(prompts).toEqual(["Use “Bilibili 登录” for this background task?"]);
  }
  const approved = fixture(false, 0);
  await approved.bridge.confirmTaskCookie(approved.binding, input, "yt-dlp");
  expect(approved.prompts).toHaveLength(1);
});
