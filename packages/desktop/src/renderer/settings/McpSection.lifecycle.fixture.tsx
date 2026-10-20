// Child-process isolation keeps shared dialog mocks out of other renderer tests.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";

ensureMiniDom();
const scenario = process.argv[2];
const argsScenario = scenario.startsWith("args-");
const renameScenario = scenario.startsWith("rename-");
const denied: string[] = [];
let guardProbes = 0;
if (argsScenario || renameScenario) {
  const deny = (kind: string): never => {
    denied.push(kind);
    throw new Error(`Owned MCP ${renameScenario ? "rename" : "args"} fixture denied ${kind}`);
  };
  for (const [object, keys, kind] of [
    [globalThis, ["fetch"], "fetch"],
    [http, ["get", "request"], "http"],
    [https, ["get", "request"], "https"],
    [net, ["connect", "createConnection"], "socket"],
    [tls, ["connect"], "tls"],
    [
      children,
      ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
      "process",
    ],
    [Bun, ["spawn", "spawnSync"], "bun-process"],
    [process, ["kill"], "signal"],
  ] as const) {
    for (const key of keys) (object as any)[key] = () => deny(kind);
  }
  syncBuiltinESMExports();
  for (const probe of [
    () => fetch("https://example.invalid/denied"),
    () => http.request("http://127.0.0.1:9/denied"),
    () => https.get("https://example.invalid/denied"),
    () => net.connect(9, "127.0.0.1"),
    () => tls.connect(443, "example.invalid"),
    () => children.spawn("owned-denied-executable", []),
    () => Bun.spawn(["owned-denied-executable"]),
    () => process.kill(0, 0),
  ])
    assert.throws(probe, /Owned MCP (?:args|rename) fixture denied /);
  guardProbes = denied.length;
  denied.length = 0;
}
const importedArgs = [
  "--label",
  "a b",
  "",
  "  ",
  'a"b',
  "c'd",
  "C:\\Program Files\\MCP",
  "中文 空格",
];
const argsServers: Record<string, Record<string, unknown>> = scenario === "args-imported"
  ? { "server-a": { command: "fixture-tool", args: [...importedArgs] } }
  : {};
// Execute only these three pinned, import-free source declarations, not the
// settings-service module (which imports Core and owns actual filesystem I/O).
const mergeSourceSHA256 = "025fea64b52ad94d36bcb76759dfe586a363eb8667cf7bbb7118b8caeae21511";
let mergeSettings:
  | ((current: Record<string, unknown>, patch: Record<string, unknown>) => Record<string, unknown>)
  | undefined;
function extractPureMergeDeclarations(sourceText: string): string {
  sourceText = sourceText.replace(/\r\n/g, "\n");
  const source = ts.createSourceFile(
    "settings-service.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = ["FORBIDDEN_SETTING_KEYS", "deepMerge", "stripNulls"];
  const declarations = names
    .map((name) => {
      const matches = source.statements.filter((node) =>
        ts.isFunctionDeclaration(node)
          ? node.name?.text === name
          : ts.isVariableStatement(node) &&
            node.declarationList.declarations.some(
              (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
            ),
      );
      assert.equal(matches.length, 1, `Exactly one complete ${name} declaration`);
      const declaration = matches[0];
      const inspect = (node: ts.Node) => {
        assert.ok(
          !ts.isImportDeclaration(node) &&
            !ts.isImportEqualsDeclaration(node) &&
            !ts.isExportDeclaration(node),
        );
        if (ts.isCallExpression(node)) {
          const called = node.expression.getText(source);
          assert.ok(
            [
              "Object.entries",
              "Array.isArray",
              "deepMerge",
              "stripNulls",
              "FORBIDDEN_SETTING_KEYS.has",
            ].includes(called),
            `Only reviewed pure dependency ${called}`,
          );
        }
        if (ts.isNewExpression(node)) assert.equal(node.expression.getText(source), "Set");
        ts.forEachChild(node, inspect);
      };
      inspect(declaration);
      return declaration.getText(source);
    })
    .join("\n\n");
  return declarations;
}
if (renameScenario) {
  const sourceText = readFileSync(
    new URL("../../main/settings-service.ts", import.meta.url),
    "utf8",
  );
  const lfSource = sourceText.replace(/\r\n/g, "\n");
  const declarations = extractPureMergeDeclarations(sourceText);
  // Two real text representations, one pinned import-free function program.
  assert.equal(extractPureMergeDeclarations(lfSource), declarations);
  assert.equal(extractPureMergeDeclarations(lfSource.replace(/\n/g, "\r\n")), declarations);
  assert.equal(createHash("sha256").update(declarations).digest("hex"), mergeSourceSHA256);
  const pureJs = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(declarations);
  mergeSettings = new Function(`${pureJs}\nreturn deepMerge;`)();
}

const manualOptions = { connectTimeoutMs: 90_000, connectRetries: 0, inlineImages: false };
const originalConfig = {
  command: "fixture-tool",
  args: ["--label", "a b"],
  env: { KEEP: "old", DROP: "old" },
  allowedTools: ["read"],
  enabled: false,
  ...manualOptions,
};
let renameStore: Record<string, any> = {
  mcpServers: {
    "server-a": structuredClone(originalConfig),
    sibling: { command: "sibling-tool", connectRetries: 2 },
  },
  unrelated: { value: "unchanged" },
};

const writes: unknown[][] = [];
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const confirmation = deferred<boolean>();
const pendingRead = deferred<Record<string, unknown>>();
const pendingWrite = deferred<void>();
const pendingRenameRefresh = deferred<Record<string, unknown>>();
let holdRenameRefresh = scenario === "rename-options-project";
const server = (name: string) => ({
  [name]: {
    command: "fixture-tool",
    source: "settings",
    editable: true,
    ...(scenario === "disabled-save" ? { enabled: false } : {}),
  },
});
let projectPath = "/fixture/project-a";
let writesFail = scenario === "save-error";
const mergedTargets: unknown[] = [];
const probeTargets: unknown[] = [];
const hasServers = [
  "stale-confirmation",
  "stale-load",
  "editor-switch",
  "probe-error",
  "patch-only-edited",
  "rename",
  "disabled-save",
  "toggle-only-enabled",
].includes(scenario);
const t = (key: string) => key;
mock.module("../i18n/I18nProvider", () => ({ useT: () => ({ t }) }));
mock.module("../ui/ConfirmDialog", () => ({
  useConfirm: () => () =>
    scenario === "stale-confirmation" ? confirmation.promise : Promise.resolve(true),
  truncateTitle: (s: string) => s,
}));
mock.module("../ui/ToastProvider", () => ({ useToast: () => () => {} }));
mock.module("../settingsAuthority", () => ({
  readScopedSettings: async (_scope: string, path: string) => {
    if (renameScenario) {
      if (holdRenameRefresh && writes.length > 0) return pendingRenameRefresh.promise;
      return structuredClone(renameStore);
    }
    if (scenario === "stale-load" && path.endsWith("project-a")) return pendingRead.promise;
    return {
      mcpServers: argsScenario
        ? argsServers
        : hasServers
          ? server(path.endsWith("project-a") ? "server-a" : "server-b")
          : {},
    };
  },
  updateScopedSettings: async (...args: unknown[]) => {
    writes.push(args);
    if (renameScenario) {
      // Real production merge function, JSON patch transport, owned memory sink.
      // Never import Main settings I/O or touch an actual configuration file.
      renameStore = mergeSettings!(renameStore, JSON.parse(JSON.stringify(args[1])));
    }
    if (argsScenario) {
      // Owned in-memory settings sink; the component still authors the real patch.
      for (const [name, patch] of Object.entries((args[1] as any).mcpServers ?? {})) {
        if (patch === null) delete argsServers[name];
        else {
          const next = { ...argsServers[name] };
          for (const [key, value] of Object.entries(patch as object)) {
            if (value === null) delete next[key];
            else next[key] = Array.isArray(value) ? [...value] : value;
          }
          argsServers[name] = next;
        }
      }
    }
    if (writesFail) throw new Error("fixture settings write failed");
    if (["save-lock", "stale-save"].includes(scenario)) await pendingWrite.promise;
  },
}));
mock.module("../configurationTarget", () => ({
  optionalProjectConfigurationTarget: (path: string) => (path ? { projectId: path } : null),
}));
Object.assign(window, {
  codeshell: {
    listMergedMcpServers: async (value: unknown, _disabled: unknown, target: unknown) => {
      mergedTargets.push(target);
      if (renameScenario) {
        if (scenario === "rename-plugin-override")
          return {
            "owned-plugin:server-a": { ...originalConfig, source: "plugin", editable: false },
          };
        return Object.fromEntries(
          Object.entries(value as Record<string, object>).map(([name, config]) => [
            name,
            {
              ...config,
              source: "settings",
              editable: true,
              hasOverride: true,
              pluginDisabled: false,
            },
          ]),
        );
      }
      return scenario === "editor-switch"
        ? { ...server("server-a"), ...server("server-b") }
        : value;
    },
    listPluginMcpTrust: async () => [],
    invalidateMcpProbeCache: async () => {},
    probeMcpServers: async (inputs: Array<{ name: string }>, force: boolean, target: unknown) => {
      probeTargets.push(target);
      if (scenario === "probe-error" && force) throw new Error("fixture probe failed");
      return inputs.map(({ name }) => ({ name, status: "connected", tools: [] }));
    },
    credentials: {
      list: async () => {
        if (scenario === "credentials-error") throw new Error("fixture credentials unavailable");
        return [];
      },
    },
  },
});
const { McpSection } = await import("./McpSection");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
function nodes(node: any): any[] {
  return [node, ...Array.from(node.childNodes ?? []).flatMap(nodes)];
}
function props(node: any): Record<string, any> {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps$"));
  return key ? node[key] : {};
}
function textOf(node: any): string {
  if (node.nodeType === 3) return node.data ?? node.textContent ?? "";
  const children = Array.from(node.childNodes ?? []);
  return children.length ? children.map(textOf).join("") : (node.textContent ?? "");
}
function find(test: (node: any) => boolean) {
  const node = nodes(container).find(test);
  assert.ok(node, "expected control");
  return node;
}
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function click(text: string) {
  await update(() => props(find((n) => n.tagName === "BUTTON" && textOf(n) === text)).onClick());
}
async function render() {
  await update(() =>
    root.render(
      <McpSection
        scope={scenario === "rename-options-user" ? "user" : "project"}
        activeProjectPath={null}
        settingsProjectPath={projectPath}
      />,
    ),
  );
}
async function fillDraft() {
  await click("settingsX.mcp.addServer");
  const inputs = nodes(container).filter((n) => n.tagName === "INPUT");
  await update(() =>
    props(inputs.find((n) => props(n).placeholder === "my-server")).onChange({
      target: { value: "project-a-private-server" },
    }),
  );
  await update(() => props(inputs[1]).onChange({ target: { value: "fixture-tool" } }));
}
try {
  await render();
  if (renameScenario) {
    const setField = async (tagName: string, placeholder: string, value: string) =>
      update(() =>
        props(find((n) => n.tagName === tagName && props(n).placeholder === placeholder)).onChange({
          target: { value },
        }),
      );
    const before = structuredClone(renameStore);
    if (scenario === "rename-plugin-override") {
      await click("settingsX.mcp.supplementCred");
      assert.equal(
        props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).disabled,
        true,
      );
      await setField("TEXTAREA", "FOO=bar\nBAZ=qux", "KEEP=override");
      await click("settingsX.mcp.save");
      assert.equal(writes.length, 1);
      assert.equal(writes[0][0], "user");
      assert.equal(writes[0][2], undefined);
      assert.deepEqual(Object.keys(writes[0][1] as object), ["mcpServerOverrides"]);
      const patch = (writes[0][1] as any).mcpServerOverrides["owned-plugin:server-a"];
      for (const field of [
        "name",
        "command",
        "args",
        "url",
        "transport",
        ...Object.keys(manualOptions),
      ])
        assert.ok(!Object.hasOwn(patch, field));
      assert.deepEqual(renameStore.mcpServers, before.mcpServers);
      assert.deepEqual(renameStore.mcpServerOverrides["owned-plugin:server-a"].env, {
        KEEP: "override",
      });
    } else {
      const editButtons = nodes(container).filter(
        (n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.edit",
      );
      await update(() => props(editButtons[0]).onClick());
      const renamed = scenario !== "rename-same-name";
      if (renamed) await setField("INPUT", "my-server", "renamed 中文");
      if (["rename-edited-cleared", "rename-same-name"].includes(scenario))
        await setField("INPUT", "npx", "fixture-other-tool");
      if (scenario === "rename-edited-cleared") {
        await setField("INPUT", "-y @playwright/mcp@latest", "");
        await setField("TEXTAREA", "FOO=bar\nBAZ=qux", "");
        await setField("TEXTAREA", "search\nread_document", "");
      }
      await click("settingsX.mcp.save");
      assert.equal(writes.length, 1, "One atomic patch, including the old-key tombstone");
      const record = (writes[0][1] as any).mcpServers;
      const name = renamed ? "renamed 中文" : "server-a";
      assert.equal(writes[0][0], scenario === "rename-options-user" ? "user" : "project");
      assert.equal(writes[0][2], scenario === "rename-options-user" ? undefined : projectPath);
      assert.deepEqual(
        Object.keys(record).sort(),
        renamed ? ["renamed 中文", "server-a"] : ["server-a"],
      );
      if (renamed) {
        assert.equal(record["server-a"], null);
        assert.ok(!Object.hasOwn(renameStore.mcpServers, "server-a"));
      }
      const stored = renameStore.mcpServers[name];
      for (const [field, expected] of Object.entries(manualOptions))
        assert.equal(stored[field], expected, `Preserve supported unedited ${field}`);
      for (const field of ["name", "source", "editable", "hasOverride", "pluginDisabled"])
        assert.ok(!Object.hasOwn(stored, field), `Do not persist UI metadata ${field}`);
      assert.equal(stored.enabled, false);
      assert.deepEqual(renameStore.mcpServers.sibling, before.mcpServers.sibling);
      assert.deepEqual(renameStore.unrelated, before.unrelated);
      assert.equal(
        stored.command,
        ["rename-edited-cleared", "rename-same-name"].includes(scenario)
          ? "fixture-other-tool"
          : originalConfig.command,
      );
      if (scenario === "rename-edited-cleared") {
        for (const field of ["args", "env", "allowedTools"]) {
          assert.equal(record[name][field], null);
          assert.ok(!Object.hasOwn(stored, field), `Explicit clear survives merge for ${field}`);
        }
      } else
        assert.deepEqual(
          stored.args,
          originalConfig.args,
          "The separate args09e fix remains intact",
        );
      if (scenario === "rename-options-project") {
        // Keep the production settings-refresh result pending so the second
        // editor opens from the component's just-saved local next, not a reload.
        const row = find((n) => n.tagName === "ARTICLE" && textOf(n).includes("renamed 中文"));
        await update(() =>
          props(
            nodes(row).find(
              (n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.edit",
            ),
          ).onClick(),
        );
        await setField("INPUT", "my-server", "renamed twice");
        await click("settingsX.mcp.save");
        assert.equal(writes.length, 2);
        const secondPatch = (writes[1][1] as any).mcpServers;
        assert.deepEqual(Object.keys(secondPatch).sort(), ["renamed twice", "renamed 中文"]);
        assert.equal(secondPatch["renamed 中文"], null);
        assert.ok(!Object.hasOwn(renameStore.mcpServers, "renamed 中文"));
        for (const [field, expected] of Object.entries(manualOptions))
          assert.equal(
            renameStore.mcpServers["renamed twice"][field],
            expected,
            `Local editor preserves ${field} before refresh`,
          );
        assert.deepEqual(renameStore.mcpServers.sibling, before.mcpServers.sibling);
        holdRenameRefresh = false;
        await update(() => pendingRenameRefresh.resolve(structuredClone(renameStore)));
      }
    }
  } else if (argsScenario) {
    const setField = async (placeholder: string, value: string) =>
      update(() =>
        props(find((n) => n.tagName === "INPUT" && props(n).placeholder === placeholder)).onChange({
          target: { value },
        }),
      );
    const name = scenario === "args-imported" ? "server-a" : "project-a-private-server";
    const expected =
      scenario === "args-imported" ? importedArgs : ["--label", "a b", "--name", "中文 空格"];
    if (scenario !== "args-imported") {
      await fillDraft();
      await setField("-y @playwright/mcp@latest", "--label \"a b\" --name '中文 空格'");
      await click("settingsX.mcp.add");
      assert.deepEqual(
        argsServers[name].args,
        expected,
        "The actual create form parses quoted arguments",
      );
    }
    await click("settingsX.mcp.edit");
    if (scenario === "args-other-field") await setField("npx", "fixture-other-tool");
    if (scenario === "args-edit")
      await setField("-y @playwright/mcp@latest", '--changed "new value"');
    if (scenario === "args-clear") await setField("-y @playwright/mcp@latest", "");
    await click("settingsX.mcp.save");
    assert.deepEqual(
      argsServers[name].args,
      scenario === "args-edit"
        ? ["--changed", "new value"]
        : scenario === "args-clear"
          ? undefined
          : expected,
      "Reopening and saving must preserve existing argument boundaries unless Args is edited",
    );
    assert.equal(writes.length, scenario === "args-imported" ? 1 : 2);
    if (scenario === "args-other-field")
      assert.equal(argsServers[name].command, "fixture-other-tool");
  } else if (scenario === "credentials-error") {
    await click("settingsX.mcp.addServer");
    assert.ok(textOf(container).includes("fixture credentials unavailable"));
    assert.ok(nodes(container).some((n) => props(n).role === "alert"));
  } else if (scenario === "target-switch") {
    await fillDraft();
    projectPath = "/fixture/project-b";
    await render();
    assert.equal(
      nodes(container).filter((n) => n.tagName === "INPUT").length,
      0,
      "Old project draft must close",
    );
    await click("settingsX.mcp.addServer");
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "",
    );
    assert.equal(writes.length, 0);
  } else if (scenario === "stale-confirmation") {
    await update(() =>
      props(
        find((n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.delete"),
      ).onClick(),
    );
    projectPath = "/fixture/project-b";
    await render();
    await update(() => confirmation.resolve(true));
    assert.equal(writes.length, 0, "A stale confirmation must not mutate either project");
    assert.ok(textOf(container).includes("server-b"));
  } else if (scenario === "stale-load") {
    projectPath = "/fixture/project-b";
    await render();
    await update(() => pendingRead.resolve({ mcpServers: server("server-a") }));
    assert.ok(textOf(container).includes("server-b"));
    assert.ok(!textOf(container).includes("server-a"));
    assert.deepEqual(mergedTargets, [{ projectId: "/fixture/project-b" }]);
  } else if (scenario === "save-error") {
    await fillDraft();
    await click("settingsX.mcp.add");
    assert.equal(writes.length, 1);
    assert.ok(textOf(container).includes("fixture settings write failed"));
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "project-a-private-server",
    );
    writesFail = false;
    await click("settingsX.mcp.add");
    assert.equal(writes.length, 2, "Failed writes remain retryable");
  } else if (scenario === "save-lock") {
    await fillDraft();
    const submit = props(
      find((n) => n.tagName === "BUTTON" && textOf(n) === "settingsX.mcp.add"),
    ).onClick;
    await update(() => {
      submit();
      submit();
    });
    assert.equal(writes.length, 1, "Same-frame double-click can write only once");
    await update(() => pendingWrite.resolve());
    assert.equal(nodes(container).filter((n) => n.tagName === "INPUT").length, 0);
  } else if (scenario === "stale-save") {
    await fillDraft();
    await click("settingsX.mcp.add");
    await click("settingsX.mcp.close");
    await click("settingsX.mcp.addServer");
    await update(() => pendingWrite.resolve());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "",
      "An old save must not close a newly opened editor",
    );
  } else if (scenario === "patch-only-edited") {
    await fillDraft();
    await click("settingsX.mcp.add");
    assert.deepEqual(
      Object.keys((writes[0][1] as any).mcpServers),
      ["project-a-private-server"],
      "An edit must not replay stale sibling configs",
    );
  } else if (scenario === "editor-switch") {
    const edits = nodes(container).filter(
      (n) => n.tagName === "BUTTON" && props(n).title === "settingsX.mcp.edit",
    );
    await update(() => props(edits[0]).onClick());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "server-a",
    );
    await update(() => props(edits[1]).onClick());
    assert.equal(
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).value,
      "server-b",
    );
  } else if (scenario === "toggle-only-enabled") {
    await update(() =>
      props(find((n) => props(n).role === "switch")).onClick({
        defaultPrevented: false,
        stopPropagation() {},
      }),
    );
    assert.deepEqual(
      writes[0][1],
      { mcpServers: { "server-a": { enabled: false } } },
      "A toggle cannot overwrite concurrently edited configuration",
    );
  } else if (scenario === "disabled-save") {
    await click("settingsX.mcp.edit");
    await click("settingsX.mcp.save");
    assert.equal(
      (writes[0][1] as any).mcpServers["server-a"].enabled,
      false,
      "Editing an inactive server must not enable it",
    );
  } else if (scenario === "rename") {
    await click("settingsX.mcp.edit");
    await update(() =>
      props(find((n) => n.tagName === "INPUT" && props(n).placeholder === "my-server")).onChange({
        target: { value: "renamed" },
      }),
    );
    await click("settingsX.mcp.save");
    assert.equal(writes.length, 1, "Renaming must remain one atomic settings patch");
    const patch = (writes[0][1] as any).mcpServers;
    assert.deepEqual(Object.keys(patch).sort(), ["renamed", "server-a"]);
    assert.equal(patch["server-a"], null);
    assert.equal(patch.renamed.command, "fixture-tool");
  } else if (scenario === "probe-error") {
    await click("settingsX.mcp.test");
    assert.ok(textOf(container).includes("fixture probe failed"));
    assert.ok(probeTargets.length > 0);
    assert.deepEqual(probeTargets.at(-1), { projectId: "/fixture/project-a" });
  } else throw new Error(`Unknown scenario: ${scenario}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(unhandled, [], "Async failures must be handled in the UI");
  if (renameScenario) {
    assert.equal(guardProbes, 8);
    assert.deepEqual(denied, []);
    console.log(
      "OWNED_MCP_RENAME_GUARD " +
        JSON.stringify({ probes: guardProbes, actualAttempts: denied.length, mergeSourceSHA256 }),
    );
  }
  if (argsScenario) {
    assert.equal(guardProbes, 8);
    assert.deepEqual(denied, []);
    console.log(
      "OWNED_MCP_ARGS_GUARD " +
        JSON.stringify({ probes: guardProbes, actualAttempts: denied.length }),
    );
  }
} finally {
  await update(() => root.unmount());
  document.body.removeChild(container);
}
