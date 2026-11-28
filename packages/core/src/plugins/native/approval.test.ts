import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins, writeInstalledPlugins } from "../installedPlugins.js";
import { installPluginFromPath } from "../installer/install.js";
import { updatePluginByName } from "../installer/update.js";
import { approvePluginHooks, reviewPluginHooks } from "../pluginHookApproval.js";
import { listPluginMcpTrust } from "../pluginMcpApproval.js";
import {
  approvePlugin,
  inspectNativePlugin,
  listNativePlugins,
  reviewNativePlugin,
  revokePlugin,
} from "./approval.js";

describe("native plugin approval", () => {
  let home: string;
  let previousHome: string | undefined;
  let source: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "native-approval-"));
    process.env.HOME = home;
    source = join(home, "source");
    mkdirSync(join(source, ".codeshell-plugin"), { recursive: true });
    mkdirSync(join(source, "dist"));
    writeFileSync(join(source, "dist", "index.js"), "export default { setup() {} };\n");
    writeManifest({ contributes: { hooks: ["pre_tool_use"], tools: ["lookup"] } });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeManifest(fields: Record<string, unknown>, root = source): void {
    writeFileSync(
      join(root, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({ schemaVersion: 2, apiVersion: 1, main: "./dist/index.js", ...fields }),
    );
  }

  function entry(key = "demo@local") {
    return readInstalledPlugins().plugins[key]![0]!;
  }

  function nativeState(key = "demo@local") {
    return inspectNativePlugin(key, entry(key)).state;
  }

  test("a freshly installed native plugin is pending and runs nothing until approved", async () => {
    await installPluginFromPath(source, "demo", "t1");
    expect(nativeState()).toBe("pending");
    expect(entry().contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry().approvedNativeDigest).toBeUndefined();

    expect(approvePlugin("demo")).toEqual([
      {
        installKey: "demo@local",
        plugin: "demo",
        hooks: "none",
        mcp: "none",
        native: "approved",
        changed: true,
      },
    ]);
    expect(nativeState()).toBe("approved");
    expect(entry().approvedNativeDigest).toBe(entry().contentDigest);
    expect(entry().approvedNativeSurface).toMatchObject({
      apiVersion: 1,
      hooks: ["pre_tool_use"],
      tools: ["lookup"],
    });
    expect(approvePlugin("demo")[0]?.changed).toBe(false);
  });

  test("a plugin without a native entry is none, and the list only holds native ones", async () => {
    const plain = join(home, "plain");
    mkdirSync(join(plain, "skills", "s"), { recursive: true });
    writeFileSync(join(plain, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
    await installPluginFromPath(plain, "plain", "t1");
    await installPluginFromPath(source, "demo", "t1");

    expect(nativeState("plain@local")).toBe("none");
    expect(listNativePlugins().map((item) => item.installKey)).toEqual(["demo@local"]);
  });

  test("one approval covers command hooks, MCP servers and the native entry together", async () => {
    mkdirSync(join(source, "hooks"));
    writeFileSync(
      join(source, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    writeFileSync(
      join(source, "mcp-servers.json"),
      JSON.stringify({ "demo:server": { command: "demo-mcp", name: "demo:server" } }),
    );
    await installPluginFromPath(source, "demo", "t1");

    expect(approvePlugin("demo@local")[0]).toMatchObject({
      hooks: "approved",
      mcp: "approved",
      native: "approved",
      changed: true,
    });
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
    expect(listPluginMcpTrust()[0]?.status).toBe("approved");

    expect(revokePlugin("demo")[0]).toMatchObject({
      hooks: "pending",
      mcp: "pending",
      native: "pending",
      changed: true,
    });
    expect(entry().approvedContentDigest).toBeUndefined();
    // The surface stays as the baseline for the next review.
    expect(entry().approvedNativeSurface).toBeDefined();
  });

  test("a native entry added locally to an approved plugin is approved with it", async () => {
    const plain = join(home, "plain");
    mkdirSync(join(plain, "hooks"), { recursive: true });
    writeFileSync(
      join(plain, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    const installed = await installPluginFromPath(plain, "plain", "t1");
    approvePlugin("plain");

    mkdirSync(join(installed, ".codeshell-plugin"));
    mkdirSync(join(installed, "dist"));
    writeFileSync(join(installed, "dist", "index.js"), "export default { setup() {} };\n");
    writeManifest({ contributes: { tools: ["lookup"] } }, installed);
    expect(nativeState("plain@local")).toBe("approved");
  });

  test("approving only the command hooks does not start the native entry", async () => {
    mkdirSync(join(source, "hooks"));
    writeFileSync(
      join(source, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    await installPluginFromPath(source, "demo", "t1");

    approvePluginHooks("demo");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
    expect(entry().approvedContentDigest).toBe(entry().contentDigest);
    expect(nativeState()).toBe("pending");
  });

  test("code edited after approval stays approved", async () => {
    const installed = await installPluginFromPath(source, "demo", "t1");
    approvePlugin("demo");
    writeFileSync(
      join(installed, "dist", "index.js"),
      "export default { setup() { /* edited locally */ } };\n",
    );

    expect(nativeState()).toBe("approved");
    expect(approvePlugin("demo")[0]?.changed).toBe(false);
  });

  test("an unusable manifest or a newer API fails the whole approval and writes nothing", async () => {
    const installed = await installPluginFromPath(source, "demo", "t1");
    const before = JSON.stringify(readInstalledPlugins());

    writeManifest({ apiVersion: 2 }, installed);
    expect(inspectNativePlugin("demo@local", entry())).toMatchObject({ state: "incompatible" });
    expect(() => approvePlugin("demo")).toThrow(/cannot be approved/);

    writeManifest({ contributes: { hooks: ["on_everything"] } }, installed);
    expect(nativeState()).toBe("invalid");
    expect(() => approvePlugin("demo")).toThrow(/cannot be approved/);
    expect(JSON.stringify(readInstalledPlugins())).toBe(before);
  });

  test("an install key whose plugin name cannot prefix public names is invalid", async () => {
    await installPluginFromPath(source, "demo", "t1");
    const data = readInstalledPlugins();
    data.plugins["my.plugin@local"] = data.plugins["demo@local"]!;
    delete data.plugins["demo@local"];
    writeInstalledPlugins(data);
    expect(inspectNativePlugin("my.plugin@local", entry("my.plugin@local"))).toMatchObject({
      state: "invalid",
    });
  });

  test("an update from a local directory keeps the approval; the review shows what changed", async () => {
    await installPluginFromPath(source, "demo", "t1");
    approvePlugin("demo");

    writeManifest({
      contributes: { hooks: ["pre_tool_use", "on_stop"], tools: ["search"], background: true },
      coreCapabilities: ["llm"],
    });
    await updatePluginByName("demo", "t2", true);
    // The new bytes come from the user's own directory, not from a download.
    expect(nativeState()).toBe("approved");
    expect(reviewNativePlugin("demo")[0]).toMatchObject({
      installKey: "demo@local",
      state: "approved",
      baselineAvailable: true,
      diff: {
        added: { hooks: ["on_stop"], tools: ["search"], coreCapabilities: ["llm"] },
        removed: { tools: ["lookup"] },
        background: { from: false, to: true },
      },
    });

    approvePlugin("demo");
    expect(reviewNativePlugin("demo")[0]).toMatchObject({
      state: "approved",
      diff: { added: {}, removed: {} },
    });
  });

  test("a first review has no baseline and lists everything as new", async () => {
    await installPluginFromPath(source, "demo", "t1");
    expect(reviewNativePlugin("demo")[0]).toMatchObject({
      baselineAvailable: false,
      diff: { added: { hooks: ["pre_tool_use"], tools: ["lookup"] }, removed: {} },
    });
  });
});
