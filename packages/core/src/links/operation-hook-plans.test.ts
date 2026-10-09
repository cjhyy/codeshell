import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { installLocalNetworkGuard } from "../../../../scripts/runtime-cost-smoke-isolation.mjs";

const guardOrigin = "http://127.0.0.1:9";
const guardMarker = Symbol.for("codeshell.cost-smoke.network-guard");
const priorMarker = Object.getOwnPropertyDescriptor(globalThis, guardMarker);
const networkSurfaces = [
  [globalThis, "fetch"],
  [http, "request"],
  [http, "get"],
  [https, "request"],
  [https, "get"],
] as const;
const priorNetwork = networkSurfaces.map(([target, key]) => ({
  target: target as unknown as Record<string, unknown>,
  key,
  descriptor: Object.getOwnPropertyDescriptor(target, key),
}));
installLocalNetworkGuard(guardOrigin);
const ownedNetwork = priorNetwork.map((surface) => surface.target[surface.key]);
// Bun runs other files in this process. Restore exactly the wrappers/descriptors
// present before this suite, including an outer guard, before another file runs.
afterAll(() => {
  try {
    for (const [index, surface] of priorNetwork.entries())
      if (surface.target[surface.key] !== ownedNetwork[index])
        throw new Error("Another fixture changed this suite's active network guard");
    if (Reflect.get(globalThis, guardMarker) !== guardOrigin)
      throw new Error("Another fixture changed this suite's active guard marker");
    for (const surface of priorNetwork) {
      if (surface.descriptor)
        Object.defineProperty(surface.target, surface.key, surface.descriptor);
      else Reflect.deleteProperty(surface.target, surface.key);
    }
    if (priorMarker) Object.defineProperty(globalThis, guardMarker, priorMarker);
    else Reflect.deleteProperty(globalThis, guardMarker);
  } finally {
    syncBuiltinESMExports();
  }
});
expect(() => fetch("https://example.invalid")).toThrow();
const { parseOperationHookHost } = await import("./operation-hook-plans.js");
const { assertHookResourceNotCredential, createHookCredentialPolicy } =
  await import("./operation-hook-credentials.js");
const { captureResources } = await import("../runtime/constrained-process/resources.js");
const { validateProcessLaunch } = await import("../runtime/constrained-process/layout.js");
const { createOperationHookHost } = await import("./operation-hook-host.js");
const { createOperationHookRegistry } = await import("./operation-hooks.js");
const { SettingsManager } = await import("../settings/manager.js");
const { prepareConfiguredToolHooks } = await import("../hooks/configured-tool-hooks.js");
const { readInstalledPlugins, readInstalledPluginsForHookHost } =
  await import("../plugins/installedPlugins.js");
const { listPluginHooksForHost } = await import("../plugins/loadPluginHooks.js");
const { createHookSourceCustody } = await import("./operation-hook-custody.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "hook-plan-unit-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const runtime = {
  executable: realpathSync(process.execPath),
  executableSha256: hash(readFileSync(realpathSync(process.execPath))),
  endpoint: "unix:///synthetic-no-daemon.sock",
  image: `sha256:${"1".repeat(64)}`,
  architecture: "arm64",
  nodeExecutable: "/usr/local/bin/node",
  nodeExecutableSha256: "2".repeat(64),
};
const context = { cwd: root, settingsScope: "project" as const, profileName: null };
const command = "node declared.mjs";
function plan() {
  return {
    commandSha256: hash(command),
    event: "pre_tool_use",
    source: {
      kind: "settings",
      layer: "project",
      path: join(root, ".code-shell/settings.json"),
      rawSha256: "3".repeat(64),
      sourceLayerIndex: 0,
      definitionSha256: "4".repeat(64),
    },
    context,
    definitionCwd: null,
    files: [
      { source: join(root, "entry.mjs"), name: "scripts/entry.mjs", bytes: 2, sha256: hash("{}") },
    ],
    directories: ["scripts"],
    launch: { interpreter: "node", entry: "scripts/entry.mjs", argv: [] },
  };
}
function configuration(value: unknown = plan(), extra = {}) {
  return JSON.stringify({ runtime, inlineCommandSha256: [], resourcePlans: [value], ...extra });
}

describe("finite native Hook plans", () => {
  test("Host registry stable decoding preserves BOM rejection and invalid UTF-8 fallback lacks resource authority", () => {
    const previousHome = process.env.HOME;
    const privateHome = join(root, "registry-home"),
      installPath = join(privateHome, ".code-shell/plugins/p");
    mkdirSync(join(installPath, "hooks"), { recursive: true });
    writeFileSync(
      join(installPath, "hooks/hooks.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } }),
    );
    const registryPath = join(privateHome, ".code-shell/plugins/installed_plugins.json");
    const registry = JSON.stringify({
      version: 2,
      plugins: {
        "probe@local": [
          {
            scope: "user",
            installPath,
            version: "valid-version",
            installedAt: "stamp",
            lastUpdated: "stamp",
          },
        ],
      },
    });
    process.env.HOME = privateHome;
    try {
      writeFileSync(registryPath, registry);
      expect(readInstalledPluginsForHookHost()?.data).toEqual(readInstalledPlugins());
      expect(listPluginHooksForHost()[0].source.custody).toBeDefined();
      writeFileSync(registryPath, `\uFEFF${registry}`);
      expect(readInstalledPlugins().plugins).toEqual({});
      expect(readInstalledPluginsForHookHost()).toBeUndefined();
      expect(listPluginHooksForHost()).toEqual([]);
      const marker = registry.indexOf("valid-version");
      writeFileSync(
        registryPath,
        Buffer.concat([
          Buffer.from(registry.slice(0, marker)),
          Buffer.from([255]),
          Buffer.from(registry.slice(marker + 1)),
        ]),
      );
      expect(readInstalledPlugins().plugins["probe@local"]).toHaveLength(1);
      expect(readInstalledPluginsForHookHost()).toBeUndefined();
      const selected = listPluginHooksForHost()[0];
      expect(selected.source.custody).toBeUndefined();
      expect(() =>
        createHookSourceCustody({
          id: "probe",
          event: selected.event,
          protocol: "plugin",
          priority: 80,
          command,
          timeoutMs: 5000,
          source: selected.source,
        }),
      ).toThrow();
    } finally {
      process.env.HOME = previousHome;
    }
  });
  test("old inline shape stays valid and plan SHA covers launch, cwd and contents", () => {
    expect(
      parseOperationHookHost(JSON.stringify({ runtime, inlineCommandSha256: [hash("exit 0")] }))
        .plans,
    ).toEqual([]);
    const first = parseOperationHookHost(configuration()).plans[0];
    const changed = plan();
    changed.launch.argv.push("literal; $(ignored)" as never);
    expect(parseOperationHookHost(configuration(changed)).plans[0].planSha256).not.toBe(
      first.planSha256,
    );
  });
  test("unsafe typed credential-root custody does not disable approved closed inline", async () => {
    const privateHome = join(root, "dangling-credential-home");
    mkdirSync(privateHome);
    symlinkSync(join(privateHome, "missing-aws"), join(privateHome, ".aws"));
    const literal = "exit 0";
    const startup = createOperationHookHost(
      configuration(plan(), { inlineCommandSha256: [hash(literal)] }),
      { nativeHome: privateHome },
    )!;
    const inline = {
      id: "closed-inline",
      event: "pre_tool_use" as const,
      protocol: "settings" as const,
      priority: 50 as const,
      command: literal,
      timeoutMs: 5000,
    };
    try {
      expect(startup.hookProcesses.resolveClosure(inline, context)).toEqual({});
      expect(() => startup.hookProcesses.resolveClosure({ ...inline, command }, context)).toThrow();
      rmSync(join(privateHome, ".aws"));
      expect(() => startup.hookProcesses.resolveClosure({ ...inline, command }, context)).toThrow();
      expect(startup.hookProcesses.resolveClosure(inline, context)).toEqual({});
    } finally {
      await startup.dispose();
    }
  });
  test("rejects unknown nested fields, mode ambiguity and all path collisions before reads", () => {
    const invalid: unknown[] = [
      { ...plan(), surprise: true },
      { ...plan(), source: { ...plan().source, surprise: true } },
      { ...plan(), context: { ...context, surprise: true } },
      { ...plan(), launch: { ...plan().launch, interpreter: "/bin/bash" } },
      { ...plan(), launch: { ...plan().launch, cwd: "undeclared" } },
      { ...plan(), files: [{ ...plan().files[0], name: "../escape" }] },
      { ...plan(), files: [{ ...plan().files[0], name: "scripts" }] },
      { ...plan(), directories: [] },
      { ...plan(), files: [{ ...plan().files[0], bytes: 8 * 1024 * 1024 + 1 }] },
      { ...plan(), launch: { ...plan().launch, argv: ["\0"] } },
    ];
    for (const value of invalid)
      expect(() => parseOperationHookHost(configuration(value))).toThrow();
    expect(() =>
      parseOperationHookHost(configuration(plan(), { inlineCommandSha256: [hash(command)] })),
    ).toThrow();
    expect(() =>
      parseOperationHookHost(configuration(plan(), { runtime: { ...runtime, surprise: true } })),
    ).toThrow();
    expect(() =>
      parseOperationHookHost(configuration(plan(), { resourcePlans: [plan(), plan()] })),
    ).toThrow();
    const reordered = plan();
    reordered.source = Object.fromEntries(
      Object.entries(reordered.source).reverse(),
    ) as typeof reordered.source;
    reordered.context = Object.fromEntries(
      Object.entries(reordered.context).reverse(),
    ) as typeof reordered.context;
    expect(() =>
      parseOperationHookHost(configuration(plan(), { resourcePlans: [plan(), reordered] })),
    ).toThrow();
    expect(() =>
      parseOperationHookHost(configuration(plan(), { resourcePlans: Array(17).fill(plan()) })),
    ).toThrow();
    expect(() => parseOperationHookHost(` ${" ".repeat(32768)}${configuration()}`)).toThrow();
  });
  test("expected bytes are actual captured bytes, links reject, and identity revocation stays invalid", () => {
    const directory = join(root, "resources");
    mkdirSync(directory);
    const path = join(directory, "source.mjs");
    writeFileSync(path, "same");
    let authorized = true;
    const grant = {
      path,
      name: "source.mjs",
      expectedBytes: 4,
      expectedSha256: hash("same"),
      assertReadable() {
        if (!authorized) throw new Error("revoked");
      },
    };
    expect(() => captureResources([{ ...grant, expectedSha256: hash("different") }])).toThrow();
    expect(() =>
      captureResources([
        { ...grant, expectedSha256: { toString: () => hash("same") } as unknown as string },
      ]),
    ).toThrow();
    expect(() =>
      validateProcessLaunch(
        {
          interpreter: "node",
          entry: "source.mjs",
          argv: [],
          planSha256: { toString: () => hash("same") } as unknown as string,
        },
        ["source.mjs"],
        [],
      ),
    ).toThrow();
    const captured = captureResources([grant]);
    writeFileSync(join(directory, "unrelated"), "sibling");
    captured.assertCurrent();
    const replacement = join(directory, "replacement");
    writeFileSync(replacement, "same");
    renameSync(replacement, path);
    expect(() => captured.assertCurrent()).toThrow();
    expect(() => captured.assertCurrent()).toThrow();
    const fresh = captureResources([grant]);
    authorized = false;
    expect(() => fresh.assertCurrent()).toThrow();
    authorized = true;
    expect(() => fresh.assertCurrent()).toThrow();
    const linked = join(directory, "linked");
    symlinkSync(path, linked);
    expect(() => captureResources([{ ...grant, path: linked }])).toThrow();
    const hard = join(directory, "hard");
    linkSync(path, hard);
    expect(() => captureResources([grant])).toThrow();
    rmSync(hard);
    const mode = captureResources([grant]);
    chmodSync(path, 0o400);
    expect(() => mode.assertCurrent()).toThrow();
    let opens = 0;
    expect(() =>
      captureResources([
        {
          ...grant,
          name: "a",
          assertReadable() {
            opens++;
          },
        },
        {
          ...grant,
          name: "a/child",
          assertReadable() {
            opens++;
          },
        },
      ]),
    ).toThrow();
    expect(opens).toBe(0);
  });
  test("known credential containers reject without blanket plugin-directory exclusion", () => {
    const policy = createHookCredentialPolicy({
      nativeHome: root,
      temporaryRoot: join(root, "tmp"),
      sensitiveRoots: [
        join(root, "userData/cloud-account"),
        join(root, "userData/mobile-remote"),
        join(root, "userData/Partitions"),
      ],
    });
    for (const name of [
      ".ssh/key",
      ".aws/config",
      ".config/gcloud/state",
      ".gnupg/key",
      ".kube/config",
      ".docker/config.json",
      "Library/Keychains/data",
      ".code-shell/settings.json.bak",
      ".code-shell/settings.local.yaml",
      ".code-shell/credentials.json",
      ".code-shell/plugins/cache/p/.mcp.json",
      ".code-shell/browser-runtime/profiles/p/Cookies",
      ".code-shell/browser-runtime/chrome-native.json",
      ".code-shell/im-gateway/config.json",
      ".code-shell/im-gateway/desktop-control.json",
      ".code-shell/chat/wechat/accounts/a",
      ".code-shell/serve/access.json",
      ".code-shell/desktop/project-runtime-secrets/a",
      ".code-shell/project-control/registry.json",
      "userData/cloud-account/session.enc",
      "userData/mobile-remote/access.json",
      "userData/Partitions/p/data",
      "tmp/codeshell-cookie-leases/a",
      "project/.code-shell/settings.managed.yml",
      "project/.code-shell/credentials.json.bak",
      "project/.code-shell/credentials.json.backup",
      "project/.env.local",
      "project/.npmrc",
      "project/.netrc",
      "project/.pgpass",
      "project/.git-credentials",
      "project/id_rsa",
      "project/key.pem",
    ])
      expect(() => assertHookResourceNotCredential(join(root, name), policy)).toThrow();
    for (const name of [
      ".code-shell/plugins/cache/p/scripts/auth-helper.mjs",
      ".code-shell/plugins/cache/p/package.json",
      "project/assets/data.json",
    ])
      expect(() => assertHookResourceNotCredential(join(root, name), policy)).not.toThrow();
  });

  test("native override and canonical aliases exclude known containers while preserving ordinary scripts", () => {
    const actualHome = join(root, "actual-home"),
      aliasHome = join(root, "alias-home");
    const actualData = join(root, "actual-data"),
      aliasData = join(root, "alias-data");
    mkdirSync(actualHome);
    mkdirSync(actualData);
    symlinkSync(actualHome, aliasHome);
    symlinkSync(actualData, aliasData);
    const stateRoot = join(actualData, "custom-state");
    const policy = createHookCredentialPolicy({
      nativeHome: aliasHome,
      temporaryRoot: aliasData,
      stateRoot: join(aliasData, "custom-state"),
      sensitiveRoots: [join(aliasData, "userData/cloud-account")],
    });
    for (const path of [
      join(actualHome, ".ssh/key"),
      join(actualData, "codeshell-cookie-leases/a"),
      join(actualData, "userData/cloud-account/session.enc"),
      join(stateRoot, "desktop/project-control/registry.json"),
      join(stateRoot, "project-runtime-secrets/id/runtime.json"),
      join(stateRoot, "settings.local.yaml.bak"),
    ])
      expect(() => assertHookResourceNotCredential(path, policy)).toThrow();
    for (const path of [
      join(stateRoot, "plugins/cache/plugin/scripts/auth-helper.mjs"),
      join(actualData, "ordinary-script.mjs"),
    ])
      expect(() => assertHookResourceNotCredential(path, policy)).not.toThrow();
    if (process.platform === "darwin") {
      const aliasTmp = createHookCredentialPolicy({
        nativeHome: root,
        temporaryRoot: tmpdir(),
        sensitiveRoots: [],
      });
      expect(() =>
        assertHookResourceNotCredential(
          join(realpathSync(tmpdir()), "codeshell-cookie-leases/id"),
          aliasTmp,
        ),
      ).toThrow();
    }
  });
  test("cancelled first review does not donate authority or poison cached finite resources", async () => {
    mkdirSync(join(root, ".code-shell"), { recursive: true });
    const path = join(root, "entry.mjs");
    writeFileSync(path, "{}");
    writeFileSync(
      join(root, ".code-shell/settings.json"),
      JSON.stringify({ hooks: [{ event: "pre_tool_use", command }] }),
    );
    const settings = new SettingsManager(root, "project", true);
    settings.load(undefined, { persistMigrations: false, hookOrigins: true });
    const hooks = prepareConfiguredToolHooks({
      settings,
      cwd: root,
      settingsScope: "project",
      disabledPlugins: [],
      disabledPluginHooks: [],
      toolName: "LinkAction",
    }).descriptors;
    const origin = hooks[0].source!;
    const finite = plan();
    finite.source = Object.fromEntries(
      Object.keys(finite.source).map((key) => [key, origin[key]]),
    ) as typeof finite.source;
    const startup = createOperationHookHost(configuration(finite))!;
    let captures = 0;
    const capture = startup.hookProcesses.host.capture;
    startup.hookProcesses.host.capture = (...args) => {
      captures++;
      return capture(...args);
    };
    const first = new AbortController();
    let firstChecks = 0;
    expect(() =>
      createOperationHookRegistry({
        descriptors: hooks,
        processes: startup.hookProcesses,
        context,
        signal: first.signal,
        assertAuthorized() {
          if (++firstChecks === 2) first.abort();
          if (first.signal.aborted) throw new Error("cancelled");
        },
      }),
    ).toThrow();
    const second = new AbortController();
    let current = true;
    const registry = createOperationHookRegistry({
      descriptors: hooks,
      processes: startup.hookProcesses,
      context,
      signal: second.signal,
      assertAuthorized() {
        if (!current || second.signal.aborted) throw new Error("second revoked");
      },
    });
    expect(captures).toBe(1);
    registry.assertResourcesCurrent();
    current = false;
    expect(() => registry.bind("{}")).toThrow();
    await registry.close();
    writeFileSync(path, "!!");
    expect(() => startup.hookProcesses.resolveClosure(hooks[0], context)).toThrow();
    writeFileSync(path, "{}");
    expect(() => startup.hookProcesses.resolveClosure(hooks[0], context)).toThrow();
    expect(captures).toBe(1);
    await startup.dispose();
  });

  test("present unresolved higher config cannot select a lower resource plan, while closed inline stays ordinary", async () => {
    const priorHome = process.env.HOME;
    const privateHome = join(root, "fallback-home"),
      project = join(root, "fallback-project");
    mkdirSync(join(privateHome, ".code-shell"), { recursive: true });
    mkdirSync(join(project, ".code-shell"), { recursive: true });
    const literal = "exit 0";
    writeFileSync(
      join(privateHome, ".code-shell/settings.json"),
      JSON.stringify({ hooks: [{ event: "pre_tool_use", command: literal }] }),
    );
    const context = { cwd: project, settingsScope: "full" as const, profileName: null };
    process.env.HOME = privateHome;
    const select = () => {
      const settings = new SettingsManager(project, "full", true);
      settings.load(undefined, { persistMigrations: false, hookOrigins: true });
      return prepareConfiguredToolHooks({
        settings,
        cwd: project,
        settingsScope: "full",
        disabledPlugins: [],
        disabledPluginHooks: [],
        toolName: "LinkAction",
      }).descriptors;
    };
    let finite, inline;
    try {
      const descriptor = select()[0],
        origin = descriptor.source!;
      const expected = plan();
      expected.commandSha256 = hash(literal);
      expected.context = context;
      expected.source = Object.fromEntries(
        Object.keys(expected.source).map((key) => [key, origin[key]]),
      ) as typeof expected.source;
      finite = createOperationHookHost(configuration(expected))!;
      inline = createOperationHookHost(
        JSON.stringify({ runtime, inlineCommandSha256: [hash(literal)] }),
      )!;
      writeFileSync(join(project, ".code-shell/settings.json"), "{bad-json");
      const selected = select()[0];
      expect(selected.command).toBe(literal);
      expect(selected.source).toBeUndefined();
      let captures = 0;
      const capture = finite.hookProcesses.host.capture;
      finite.hookProcesses.host.capture = (...args) => {
        captures++;
        return capture(...args);
      };
      expect(finite.hookProcesses.resolveClosure(selected, context)).toBeUndefined();
      expect(captures).toBe(0);
      expect(inline.hookProcesses.resolveClosure(selected, context)).toEqual({});
    } finally {
      await finite?.dispose();
      await inline?.dispose();
      process.env.HOME = priorHome;
    }
  });

  test("native late state-root changes are sticky and reject resource use before capture", async () => {
    const project = join(root, "state-project");
    mkdirSync(join(project, ".code-shell"), { recursive: true });
    writeFileSync(
      join(project, ".code-shell/settings.json"),
      JSON.stringify({ hooks: [{ event: "pre_tool_use", command }] }),
    );
    const settings = new SettingsManager(project, "project", true);
    settings.load(undefined, { persistMigrations: false, hookOrigins: true });
    const descriptor = prepareConfiguredToolHooks({
      settings,
      cwd: project,
      settingsScope: "project",
      disabledPlugins: [],
      disabledPluginHooks: [],
      toolName: "LinkAction",
    }).descriptors[0];
    const expected = plan();
    expected.context = { ...context, cwd: project };
    expected.source = Object.fromEntries(
      Object.keys(expected.source).map((key) => [key, descriptor.source![key]]),
    ) as typeof expected.source;
    let nativeRootCurrent = true;
    const startup = createOperationHookHost(configuration(expected), {
      stateRoot: root,
      assertStateRootCurrent() {
        if (!nativeRootCurrent) throw new Error("late native state root");
      },
    })!;
    let captures = 0;
    const capture = startup.hookProcesses.host.capture;
    startup.hookProcesses.host.capture = (...args) => {
      captures++;
      return capture(...args);
    };
    try {
      nativeRootCurrent = false;
      expect(() => startup.hookProcesses.resolveClosure(descriptor, expected.context)).toThrow();
      nativeRootCurrent = true;
      expect(() => startup.hookProcesses.resolveClosure(descriptor, expected.context)).toThrow();
      expect(captures).toBe(0);
    } finally {
      await startup.dispose();
    }
  });
});
