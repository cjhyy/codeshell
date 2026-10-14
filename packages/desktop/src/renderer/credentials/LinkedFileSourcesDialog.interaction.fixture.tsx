// Run in an isolated child so native control and bridge mocks cannot leak into other tests.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import type { TrackedProject } from "../projects";
import type {
  AddLinkedFileSourcesInput,
  LinkedFileSourceSnapshot,
} from "../../shared/linked-file-sources";

let unexpectedRequests = 0;
const deny = () => {
  unexpectedRequests++;
  throw new Error("Linked source interaction fixture denies network requests");
};
globalThis.fetch = deny as unknown as typeof fetch;
http.request = deny as typeof http.request;
http.get = deny as typeof http.get;
https.request = deny as typeof https.request;
https.get = deny as typeof https.get;
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://fixture.invalid"),
  () => http.get("http://fixture.invalid"),
  () => http.request("http://fixture.invalid"),
  () => https.get("https://fixture.invalid"),
  () => https.request("https://fixture.invalid"),
])
  assert.throws(probe, /denies network/);
assert.equal(unexpectedRequests, 5);
unexpectedRequests = 0;
assert.equal(process.env.NODE_ENV, "test");
assert.ok(process.env.CODE_SHELL_TEST_HOME?.startsWith(`${process.env.HOME}/`));

ensureMiniDom();
const scenario = process.argv[2];
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pendingSnapshot = deferred<LinkedFileSourceSnapshot>();
const pendingAdd = deferred<{ sourceIds: string[] }>();
let dialogClose: (open: boolean) => void = () => {
  throw new Error("No dialog open");
};
const { translate } = await import("../i18n/translate");
mock.module("../i18n/I18nProvider", () => ({
  useT: () => ({ t: (key: any, parameters?: any) => translate("zh", key, parameters), lang: "zh" }),
  I18nProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
const passthrough = ({ children }: any) => <div>{children}</div>;
function optionText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(optionText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value))
    return optionText(value.props.children);
  return "";
}
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: any) => {
    if (open) dialogClose = onOpenChange;
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
}));
mock.module("@/components/ui/simple-select", () => ({
  SimpleSelect: ({ value, options, onChange, ariaLabel, disabled }: any) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="" />
      {options.map((item: any) => (
        <option key={item.value} value={item.value}>
          {optionText(item.label)}
        </option>
      ))}
    </select>
  ),
}));
mock.module("@/components/ui/checkbox", () => ({
  Checkbox: ({ onCheckedChange, ...props }: any) => (
    <input {...props} type="checkbox" onChange={(event) => onCheckedChange(event.target.checked)} />
  ),
}));

const projects: TrackedProject[] = ["a", "b"].map((id) => ({
  id: `project-${id}`,
  name: `Project ${id.toUpperCase()}`,
  path: `/fixture/project-${id}`,
  roots: [
    {
      id: `root-${id}`,
      name: `Root ${id.toUpperCase()}`,
      path: `/fixture/project-${id}`,
      addedAt: 1,
    },
  ],
  primaryRootId: `root-${id}`,
  addedAt: 1,
}));
function snapshot(projectId = "project-a"): LinkedFileSourceSnapshot {
  const second = projectId === "project-b";
  return {
    connections:
      scenario === "empty-connections"
        ? []
        : [
            {
              id: second ? "github-second" : "github-work",
              providerId: "github",
              label: second ? "Second GitHub account" : "Work GitHub account",
              accountLabel: second ? "account-b" : "account-a",
              revision: second ? "github-revision-b" : "github-revision-a",
              selection: "github-file",
              resources: [
                { id: "acme/docs", label: "Acme product docs" },
                ...(scenario === "repository-change-clears-files"
                  ? [{ id: "acme/other", label: "Other authorized repository" }]
                  : []),
              ],
              resourceRestricted: scenario !== "github-unrestricted",
            },
            {
              id: second ? "figma-second" : "figma-design",
              providerId: "figma",
              label: second ? "Second Figma account" : "Design Figma account",
              accountLabel: second ? "designer-b" : "designer-a",
              revision: second ? "figma-revision-b" : "figma-revision-a",
              selection: "figma-file",
              resources: [
                {
                  id: second ? "b-file" : "a-file",
                  label: second ? "Other project document" : "Relevant design document",
                },
                { id: "unselected-file", label: "Unrelated document" },
              ],
              resourceRestricted: scenario !== "figma-explicit",
            },
          ],
    limitations: [
      { providerId: "storage", label: "Storage service", reason: "document-content-unavailable" },
    ],
  };
}
const snapshotCalls: string[] = [];
const addCalls: Array<[string, AddLinkedFileSourcesInput]> = [];
const forbiddenCalls: unknown[] = [];
let closeCount = 0;
let addedCount = 0;
Object.assign(window, {
  codeshell: {
    linkedFileSources: {
      snapshot: async (projectId: string) => {
        snapshotCalls.push(projectId);
        if (scenario === "stale-project-snapshot" && projectId === "project-a")
          return pendingSnapshot.promise;
        if (scenario === "snapshot-failure-retry" && snapshotCalls.length === 1)
          throw new Error("connection snapshot unavailable");
        return snapshot(projectId);
      },
      add: async (projectId: string, input: AddLinkedFileSourcesInput) => {
        addCalls.push([projectId, structuredClone(input)]);
        if (scenario === "add-failure-retry" && addCalls.length === 1)
          throw new Error("connection revision changed; retry selection");
        if (["add-lock", "add-unmount", "add-project-disappears"].includes(scenario))
          return pendingAdd.promise;
        return { sourceIds: ["focused-source-a"] };
      },
    },
    executeLinkAction: (...args: unknown[]) => forbiddenCalls.push(args),
    bindProjectSource: (...args: unknown[]) => forbiddenCalls.push(args),
    saveSourceCatalog: (...args: unknown[]) => forbiddenCalls.push(args),
  },
});
const { LinkedFileSourcesDialog } = await import("./LinkedFileSourcesDialog");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
let mounted = true;
const nodes = (node: any = container): any[] => [
  node,
  ...(node.childNodes ?? []).flatMap((child: any) => nodes(child)),
];
const props = (node: any): any =>
  node?.[Object.keys(node ?? {}).find((key) => key.startsWith("__reactProps$")) ?? ""] ?? {};
const text = (node: any): string =>
  node?.nodeType === 3
    ? (node.data ?? node.textContent ?? "")
    : node?.childNodes?.length
      ? node.childNodes.map(text).join("")
      : (node?.textContent ?? "");
const find = (predicate: (node: any) => boolean) => {
  const node = nodes().find(predicate);
  assert.ok(node, text(container));
  return node;
};
const button = (label: string) => find((node) => node.tagName === "BUTTON" && text(node) === label);
const field = (name: string) => find((node) => props(node).name === name);
const selection = (label: string) =>
  find((node) => node.tagName === "SELECT" && props(node)["aria-label"] === label);
const checkbox = (label: string) =>
  find((node) => props(node).type === "checkbox" && props(node)["aria-label"] === label);
async function update(operation: () => unknown) {
  await act(async () => {
    operation();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(node: any) {
  assert.equal(Boolean(props(node).disabled), false);
  await update(() => props(node).onClick());
}
async function change(name: string, value: string) {
  const node = field(name);
  assert.equal(Boolean(props(node).disabled), false);
  await update(() => props(node).onChange({ target: { value } }));
}
async function select(label: string, value: string) {
  const node = selection(label);
  assert.equal(Boolean(props(node).disabled), false);
  await update(() => props(node).onChange({ target: { value } }));
}
async function check(label: string) {
  const node = checkbox(label);
  assert.equal(Boolean(props(node).disabled), false);
  await update(() => props(node).onChange({ target: { checked: true } }));
}
async function githubInput() {
  if (scenario === "github-unrestricted") {
    await change("linked-file-owner", "  acme  ");
    await change("linked-file-repo", "  docs  ");
  } else {
    await select("仓库", "acme/docs");
  }
  await change("linked-file-paths", "  guide/setup.md\n\nreference/api.md  ");
  await change("linked-file-ref", "  release  ");
}
const expectedGithub: [string, AddLinkedFileSourcesInput] = [
  "project-a",
  {
    connectionId: "github-work",
    expectedRevision: "github-revision-a",
    files: [
      { kind: "github-file", owner: "acme", repo: "docs", path: "guide/setup.md", ref: "release" },
      {
        kind: "github-file",
        owner: "acme",
        repo: "docs",
        path: "reference/api.md",
        ref: "release",
      },
    ],
    priority: "high",
  },
];

try {
  await update(() =>
    root.render(
      <LinkedFileSourcesDialog
        projects={projects}
        initialProjectId="project-a"
        onClose={() => closeCount++}
        onAdded={() => addedCount++}
      />,
    ),
  );
  assert.equal(addCalls.length, 0);
  assert.deepEqual(forbiddenCalls, []);
  assert.deepEqual(snapshotCalls, ["project-a"]);

  if (scenario === "snapshot-failure-retry") {
    assert.ok(text(container).includes("connection snapshot unavailable"));
    await click(button("重试"));
    assert.deepEqual(snapshotCalls, ["project-a", "project-a"]);
    assert.ok(text(container).includes("Work GitHub account"));
    assert.equal(nodes().filter((node) => props(node).role === "alert").length, 0);
  } else if (scenario === "stale-project-snapshot") {
    await select("项目", "project-b");
    assert.ok(text(container).includes("Second GitHub account"));
    await update(() => pendingSnapshot.resolve(snapshot("project-a")));
    assert.equal(props(selection("已连接服务")).value, "github-second");
    assert.ok(!text(container).includes("Work GitHub account"));
    await githubInput();
    await click(button("添加到数据源"));
    assert.equal(addCalls[0][0], "project-b");
    assert.equal(addCalls[0][1].connectionId, "github-second");
    assert.equal(addCalls[0][1].expectedRevision, "github-revision-b");
    assert.equal(addedCount, 1);
  } else if (scenario === "empty-connections") {
    assert.ok(text(container).includes("Storage service"));
    assert.equal(props(button("添加到数据源")).disabled, true);
  } else if (scenario === "cancel-without-add") {
    await githubInput();
    await update(() => dialogClose(false));
    assert.equal(closeCount, 1);
    assert.equal(addedCount, 0);
  } else if (scenario === "repository-change-clears-files") {
    await githubInput();
    assert.equal(props(button("添加到数据源")).disabled, false);
    await select("仓库", "acme/other");
    assert.equal(props(field("linked-file-paths")).value, "");
    assert.equal(props(field("linked-file-ref")).value, "");
    assert.equal(props(selection("权重")).value, "high");
    assert.equal(props(button("添加到数据源")).disabled, true);
    assert.equal(addCalls.length, 0);
  } else if (scenario === "too-many-files") {
    await select("仓库", "acme/docs");
    const paths = Array.from({ length: 101 }, (_, index) => `docs/file-${index}.md`);
    await change("linked-file-paths", paths.join("\n"));
    const add = button("添加到数据源");
    assert.equal(props(add).disabled, true);
    assert.ok(text(container).includes("100"));
    await update(() => props(add).onClick());
    assert.equal(addCalls.length, 0);
    await change("linked-file-paths", paths.slice(0, 100).join("\n"));
    await click(button("添加到数据源"));
    assert.deepEqual(addCalls, [
      [
        "project-a",
        {
          connectionId: "github-work",
          expectedRevision: "github-revision-a",
          priority: "high",
          files: paths
            .slice(0, 100)
            .map((path) => ({ kind: "github-file", owner: "acme", repo: "docs", path })),
        },
      ],
    ]);
    assert.equal(addedCount, 1);
  } else if (
    scenario.startsWith("figma-") ||
    scenario === "restricted-figma" ||
    scenario.endsWith("clears-selection")
  ) {
    await select("已连接服务", "figma-design");
    const checks = nodes().filter((node) => props(node).type === "checkbox");
    assert.equal(checks.length, 2);
    for (const node of checks) assert.equal(Boolean(props(node).checked), false);
    assert.equal(props(button("添加到数据源")).disabled, true);
    if (scenario === "figma-explicit") {
      await change("linked-file-figma", "  https://www.figma.com/design/explicit-file/Product  ");
      await click(button("添加到数据源"));
      assert.deepEqual(addCalls, [
        [
          "project-a",
          {
            connectionId: "figma-design",
            expectedRevision: "figma-revision-a",
            files: [
              {
                kind: "figma-file",
                fileUrlOrKey: "https://www.figma.com/design/explicit-file/Product",
              },
            ],
            priority: "high",
          },
        ],
      ]);
      assert.equal(addedCount, 1);
    } else {
      assert.equal(nodes().filter((node) => props(node).name === "linked-file-figma").length, 0);
      await check("Relevant design document");
      assert.equal(Boolean(props(checkbox("Unrelated document")).checked), false);
      assert.equal(addCalls.length, 0);
      if (scenario === "connection-change-clears-selection") {
        await select("已连接服务", "github-work");
        await select("已连接服务", "figma-design");
        assert.equal(Boolean(props(checkbox("Relevant design document")).checked), false);
        assert.equal(props(button("添加到数据源")).disabled, true);
      } else if (scenario === "project-change-clears-selection") {
        await select("项目", "project-b");
        await select("已连接服务", "figma-second");
        assert.equal(Boolean(props(checkbox("Other project document")).checked), false);
        assert.ok(!text(container).includes("Relevant design document"));
        assert.equal(props(button("添加到数据源")).disabled, true);
      } else {
        await click(button("添加到数据源"));
        assert.deepEqual(addCalls, [
          [
            "project-a",
            {
              connectionId: "figma-design",
              expectedRevision: "figma-revision-a",
              files: [
                { kind: "figma-file", fileUrlOrKey: "a-file", label: "Relevant design document" },
              ],
              priority: "high",
            },
          ],
        ]);
        assert.equal(addedCount, 1);
      }
    }
  } else {
    assert.equal(props(selection("权重")).value, "high");
    assert.equal(props(button("添加到数据源")).disabled, true);
    await githubInput();
    assert.equal(addCalls.length, 0);
    if (scenario === "github-unseen-repository") {
      assert.equal(nodes().filter((node) => props(node).name === "linked-file-owner").length, 0);
      await select("仓库", "evil/hidden");
      assert.equal(props(button("添加到数据源")).disabled, true);
      assert.equal(addCalls.length, 0);
    } else {
      if (scenario === "normal-priority") await select("权重", "normal");
      const save = button("添加到数据源");
      await update(() => {
        props(save).onClick();
        props(save).onClick();
      });
      const expected = structuredClone(expectedGithub);
      if (scenario === "normal-priority") expected[1].priority = "normal";
      assert.deepEqual(addCalls, [expected]);
      if (scenario === "add-failure-retry") {
        assert.ok(text(container).includes("connection revision changed; retry selection"));
        assert.equal(
          props(field("linked-file-paths")).value.trim(),
          "guide/setup.md\n\nreference/api.md",
        );
        assert.equal(addedCount, 0);
        assert.equal(closeCount, 0);
        await click(button("重试"));
        assert.deepEqual(addCalls, [expected, expected]);
        assert.deepEqual(snapshotCalls, ["project-a"]);
        assert.equal(addedCount, 1);
      } else if (["add-lock", "add-unmount", "add-project-disappears"].includes(scenario)) {
        assert.equal(addedCount, 0);
        assert.equal(closeCount, 0);
        assert.equal(props(selection("项目")).disabled, true);
        assert.equal(props(selection("已连接服务")).disabled, true);
        assert.equal(props(selection("权重")).disabled, true);
        assert.equal(props(field("linked-file-paths")).disabled, true);
        await update(() => dialogClose(false));
        assert.equal(closeCount, 0);
        if (scenario === "add-unmount") {
          await update(() => root.unmount());
          mounted = false;
        }
        if (scenario === "add-project-disappears") {
          await update(() =>
            root.render(
              <LinkedFileSourcesDialog
                projects={projects.filter((project) => project.id === "project-b")}
                initialProjectId="project-a"
                onClose={() => closeCount++}
                onAdded={() => addedCount++}
              />,
            ),
          );
        }
        const closesBeforeResolution = closeCount;
        await update(() => pendingAdd.resolve({ sourceIds: ["focused-source-a"] }));
        assert.equal(addCalls.length, 1);
        const current = mounted && scenario !== "add-project-disappears";
        assert.equal(addedCount, current ? 1 : 0);
        assert.equal(closeCount, closesBeforeResolution + (current ? 1 : 0));
        if (scenario === "add-project-disappears") {
          assert.equal(props(selection("项目")).disabled, false);
          await select("项目", "project-b");
          assert.equal(props(selection("已连接服务")).value, "github-second");
          assert.equal(props(field("linked-file-paths")).value, "");
          assert.equal(props(button("添加到数据源")).disabled, true);
          await click(button("取消"));
          assert.equal(closeCount, closesBeforeResolution + 1);
          assert.equal(addCalls.length, 1);
        }
      } else {
        assert.equal(addedCount, 1);
        assert.equal(closeCount, 1);
      }
    }
  }
  if (
    [
      "snapshot-failure-retry",
      "connection-change-clears-selection",
      "project-change-clears-selection",
      "empty-connections",
      "cancel-without-add",
    ].includes(scenario)
  )
    assert.equal(addCalls.length, 0);
  assert.deepEqual(forbiddenCalls, []);
  assert.equal(unexpectedRequests, 0);
  assert.deepEqual(unhandled, []);
  if (mounted) await update(() => root.unmount());
  console.log(JSON.stringify({ scenario, passed: true, unexpectedRequests }));
} catch (error) {
  if (mounted) await update(() => root.unmount());
  throw error;
}
