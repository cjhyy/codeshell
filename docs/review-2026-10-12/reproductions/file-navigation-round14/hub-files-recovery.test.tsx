import { afterAll, expect, test } from "bun:test";
import React, { act } from "react";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (
  !process.env.CODE_SHELL_TEST_HOME ||
  !process.env.HOME?.includes("codeshell-bun-completion-")
)
  throw Error("guarded HOME required");
const repo = process.cwd();
let files: any;
const server = createServer((req, res) => {
  void files.handle(req, res).then((handled: boolean) => {
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const { installLocalNetworkGuard } = await import(
  `${repo}/scripts/runtime-cost-smoke-isolation.mjs`
);
installLocalNetworkGuard(origin);
const deny = () => {
  throw Error("NETWORK_FORBIDDEN_round14");
};
net.connect = net.createConnection = deny as any;
tls.connect = deny as any;
const guardedFetch = globalThis.fetch;
const { createHubFiles } = await import(
  `${repo}/packages/server/src/hub/files.ts`
);
const { createRoot } = await import(
  `${repo}/packages/desktop/node_modules/react-dom/client`
);
const { ensureMiniDom, flushMicrotasks } = await import(
  `${repo}/packages/desktop/src/renderer/test-utils/renderHook.tsx`
);
const { HubFiles } = await import(`${repo}/packages/web/app/HubFiles.tsx`);
const { setApiProject, setApiWorkspace } = await import(
  `${repo}/packages/web/app/api-context.ts`
);
setApiProject(null);
setApiWorkspace(undefined);
ensureMiniDom();
const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "codeshell-hub-files-round14-")),
  ),
  cwd = join(temporary, "workspace"),
  outside = join(temporary, "outside");
mkdirSync(cwd);
mkdirSync(outside);
writeFileSync(join(cwd, "A.txt"), "Owned text A");
writeFileSync(join(cwd, "B.txt"), "Owned text B");
writeFileSync(join(cwd, "move.txt"), "Owned moved text");
writeFileSync(join(cwd, "denied.txt"), "Owned permission text");
writeFileSync(join(cwd, ".env"), "FIXTURE_ONLY=yes");
writeFileSync(
  join(outside, "foreign.txt"),
  "owned but unauthorized fixture text",
);
symlinkSync(outside, join(cwd, "escape"));
let authorized = true;
files = createHubFiles({
  cwd,
  isAuthorized: async (req: any) =>
    authorized && req.headers.authorization === "Bearer owned-fixture",
});
let delayA = false,
  releaseA: any,
  initialPath: string | undefined,
  version = 0,
  authLost = 0;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = new URL(String(input), origin),
    headers = new Headers(init.headers);
  headers.set("authorization", "Bearer owned-fixture");
  const delayed =
    delayA &&
    url.pathname.endsWith("/files/content") &&
    url.searchParams.get("path") === "A.txt";
  const result = await guardedFetch(url, {
    ...init,
    signal: delayed ? undefined : init.signal,
    headers,
  });
  if (!delayed) return result;
  const body = await result.text();
  await new Promise((resolve) => {
    releaseA = resolve;
  });
  return new Response(body, { status: result.status, headers: result.headers });
}) as any;
const nodes = (node: any): any[] => [
  node,
  ...Array.from(node?.childNodes ?? []).flatMap(nodes),
];
function props(node: any): any {
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function text(node: any): string {
  return node.nodeType === 3
    ? (node.nodeValue ?? node.textContent ?? "")
    : Array.from(node.childNodes ?? [])
        .map(text)
        .join("") ||
        (typeof node.textContent === "string" ? node.textContent : "");
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const settle = async () => {
  await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  await flushMicrotasks();
};
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end)
      throw Error("fixture wait timeout: " + text(container));
    await act(settle);
  }
}
async function render() {
  await act(async () => {
    root.render(
      <HubFiles
        initialPath={initialPath}
        openVersion={version}
        onAuthLost={() => {
          authLost++;
        }}
      />,
    );
    await settle();
  });
}
function fileButton(name: string) {
  return nodes(container).find(
    (n) =>
      n.tagName === "BUTTON" &&
      props(n).className?.includes("file-entry") &&
      text(n).includes(name),
  );
}
async function clickFile(name: string) {
  const button = fileButton(name);
  expect(button).toBeDefined();
  await act(async () => {
    props(button).onClick();
    await settle();
  });
}
async function clickLabel(name: string) {
  const button = nodes(container).find(
    (n) => n.tagName === "BUTTON" && text(n) === name,
  );
  expect(button).toBeDefined();
  await act(async () => {
    props(button).onClick();
    await settle();
  });
}
const json = async (path: string, init?: any) => {
  const response = await guardedFetch(origin + path, {
    ...init,
    headers: { authorization: "Bearer owned-fixture", ...init?.headers },
  });
  return { status: response.status, body: (await response.json()) as any };
};
afterAll(async () => {
  if (releaseA) releaseA();
  await act(async () => {
    root.unmount();
    await settle();
  });
  container.parentNode?.removeChild(container);
  globalThis.fetch = guardedFetch;
  chmodSync(join(cwd, "denied.txt"), 0o600);
  files.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  rmSync(temporary, { recursive: true, force: true });
});

test("CONTROL actual Hub Files retains authorization and gives visible moved/denied errors with retry; late preview cannot override newer file", async () => {
  if (process.getuid?.() === 0)
    throw Error("nonroot UID required for actual EACCES control");
  expect((await json("/api/v1/files")).status).toBe(200);
  expect(
    (
      await json(
        "/api/v1/files/content?path=../outside/foreign.txt&preview=true",
      )
    ).status,
  ).toBe(403);
  expect(
    (await json("/api/v1/files/content?path=escape/foreign.txt&preview=true"))
      .status,
  ).toBe(403);
  expect(
    (await json("/api/v1/files/content?path=.env&preview=true")).status,
  ).toBe(403);
  expect((await json("/api/v1/files", { method: "POST" })).status).toBe(405);
  const listing = await json("/api/v1/files");
  expect(listing.body.files.map((entry: any) => entry.name)).not.toContain(
    ".env",
  );
  await render();
  await until(() => !!fileButton("move.txt"));
  renameSync(join(cwd, "move.txt"), join(cwd, "moved.txt"));
  await clickFile("move.txt");
  await until(() => text(container).includes("文件不存在或已移动"));
  expect(nodes(container).some((n) => props(n).role === "alert")).toBe(true);
  await clickLabel("刷新");
  await until(() => !!fileButton("moved.txt") && !fileButton("move.txt"));
  await clickFile("moved.txt");
  await until(() => text(container).includes("Owned moved text"));
  expect(text(container)).not.toContain("文件不存在或已移动");
  chmodSync(join(cwd, "denied.txt"), 0o000);
  await clickFile("denied.txt");
  await until(() => /没有读取.*权限/.test(text(container)));
  expect(nodes(container).some((n) => props(n).role === "alert")).toBe(true);
  chmodSync(join(cwd, "denied.txt"), 0o600);
  await clickFile("denied.txt");
  await until(() => text(container).includes("Owned permission text"));
  expect(text(container)).not.toMatch(/没有读取.*权限/);
  delayA = true;
  initialPath = "A.txt";
  version++;
  await render();
  await until(() => !!releaseA);
  initialPath = "B.txt";
  version++;
  await render();
  await until(() => text(container).includes("Owned text B"));
  await act(async () => {
    releaseA();
    await settle();
  });
  expect(text(container)).toContain("Owned text B");
  expect(text(container)).not.toContain("Owned text A");
  const download = nodes(container).find(
    (n) => n.tagName === "A" && text(n) === "下载",
  );
  expect(props(download).href).toBe("/api/v1/files/content?path=B.txt");
  authorized = false;
  await clickLabel("刷新");
  await until(() => authLost > 0);
  expect(authLost).toBeGreaterThan(0);
  expect(
    (await json("/api/v1/files/content?path=B.txt&preview=true")).status,
  ).toBe(401);
  authorized = true;
  await clickLabel("刷新");
  await until(() => !!fileButton("B.txt"));
  console.log(
    JSON.stringify({
      control: "hub-file-recovery",
      actualHubService: true,
      unauthorizedAndPrivatePathsRejected: true,
      noWriteMethod: true,
      movedFile404Visible: true,
      permission403Visible: true,
      restoredFileRetrySucceeded: true,
      lateAResponseIgnoredAfterB: true,
      currentDownloadTarget: "B.txt",
      authRevocationObserved: true,
      delayScope:
        "actual HTTP response body fully received before controlled transport-delivery delay; abort is intentionally ignored only for delayed A to exercise generation guard",
    }),
  );
});
