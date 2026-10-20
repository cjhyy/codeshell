import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";
import { PANEL_APP_API_VERSION } from "../shared/panel-apps.js";
import { claimPanelHostOwnerForRun } from "./panel-host-routing.js";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";

// Run the actual bridge methods without Electron startup. Window identities,
// protocol selection and worker transport are explicit adapters; the binding,
// revocation, ownership and submit logic are extracted unchanged from production.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const names = [
  "registerGuest",
  "revokeGuest",
  "assertTrustedHost",
  "getWindowSource",
  "bindWindowGuest",
  "subscribeWindowSource",
  "windowSourceIdentity",
  "assertWindowSource",
  "revokeWindowSource",
  "sessionOwnerWindow",
  "findAgentToolBinding",
  "bindGuest",
  "assertProjectBinding",
  "assertLiveProjectBinding",
  "assertSessionBinding",
  "agentTaskOwner",
  "submitPrompt",
];
const methods = names.map((name) => {
  const method = declaration.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name,
  );
  if (!method) throw new Error(`Missing bridge method: ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class WindowBridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

class Guest extends EventEmitter {
  destroyed = false;
  url = "cspanel://fixture/app/index.html";
  sent: unknown[][] = [];
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
  send(...args: unknown[]) {
    this.sent.push(args);
  }
  setWindowOpenHandler() {}
  stop() {}
}

async function fixture() {
  const windows = new Map<number, any>();
  const window = (id: number) => {
    const result = {
      id,
      webContents: new Guest(id * 10),
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      isVisible: () => true,
      isMinimized: () => false,
    };
    windows.set(id, result);
    return result;
  };
  const main = window(1);
  const popup = window(2);
  const other = window(3);
  const claims: unknown[][] = [];
  const runs: unknown[][] = [];
  const releases: Array<(result: { ok: boolean }) => void> = [];
  const errors: unknown[] = [];
  const revoked: number[] = [];
  let selected = true;
  let bound = true;
  const agent = {
    captureExternalOutputSource: () => ({ publish: (event: unknown) => errors.push(event) }),
    claimSessionPanelOwner: (...args: unknown[]) => claims.push(args),
    requestWorker: (...args: unknown[]) => {
      runs.push(args);
      return new Promise<{ ok: boolean }>((resolve) => releases.push(resolve));
    },
  };
  const Bridge = runInNewContext(`${compiled}\nWindowBridge`, {
    BrowserWindow: {
      fromId: (id: number) => windows.get(id) ?? null,
      fromWebContents: (sender: Guest) =>
        [...windows.values()].find((candidate) => candidate.webContents === sender) ?? null,
    },
    resolvePanelAppBindingProjectPath: (path: string) => path,
    isPanelAppDescriptorSelected: () => selected,
    PANEL_APP_API_VERSION,
    PANEL_AGENT_RUN_TIMEOUT_MS: 1000,
    MAX_AGENT_PROMPT_CHARS: 20_000,
    PanelBridgeError,
    AbortController,
    structuredClone,
    isDeepStrictEqual,
    randomUUID,
    parseExternalRuntimeModelKey,
    claimPanelHostOwnerForRun,
  });
  const bridge = new Bridge();
  bridge.options = {
    isTrustedHost: (sender: Guest) => sender === main.webContents || sender === other.webContents,
    isWorkspaceTrusted: () => true,
    isPanelAppBound: () => bound,
    getAgentBridge: () => agent,
  };
  bridge.guests = new Map();
  bridge.windowSourceListeners = new Map();
  bridge.resourceTransfers = new Map();
  bridge.pendingAgentToolCalls = new Map();
  bridge.modelTraces = { cancelOwner() {} };
  bridge.processService = { revokeGuest: (id: number) => revoked.push(id) };
  bridge.agentTaskService = { rebind() {} };
  bridge.capabilitiesFor = () => ({});
  const resource = {
    descriptor: {
      id: "panel-app:fixture",
      appId: "fixture",
      hostId: "fixture",
      title: "Fixture",
      revision: "r1",
      permissions: ["context.session", "context.workspace", "agent.submitPrompt", "agent.task"],
    },
    entry: "app/index.html",
  };
  const dock = new Guest(100);
  const detached = new Guest(200);
  bridge.registerGuest(dock, main, resource, "/project");
  bridge.registerGuest(detached, popup, resource, "/project");
  const input = {
    guestId: dock.id,
    appDescriptorId: resource.descriptor.id,
    tabId: "fixture-1",
    bucket: "project::session",
    projectPath: "/project",
    cwd: "/project",
    sessionId: "session-1",
    visible: false,
    busy: false,
    modelKey: "native-model",
    permissionMode: "default",
    planMode: false,
    hasGoal: false,
    theme: "dark",
    locale: "zh",
  };
  await bridge.bindGuest(main.webContents, input);
  const target = {
    appDescriptorId: input.appDescriptorId,
    tabId: input.tabId,
    bucket: input.bucket,
  };
  return {
    bridge,
    main,
    popup,
    other,
    dock,
    detached,
    input,
    target,
    resource,
    revoked,
    claims,
    runs,
    releases,
    errors,
    setSelected: (value: boolean) => (selected = value),
    setBound: (value: boolean) => (bound = value),
  };
}

describe("Panel App standalone window authority", () => {
  test("only the source owner can resolve an exact bound dock target", async () => {
    const f = await fixture();
    const result = f.bridge.getWindowSource(f.main.webContents, {
      ...f.target,
      permissionMode: "bypassPermissions",
    });
    expect(result.guestId).toBe(f.dock.id);
    expect(result.ownerWindowId).toBe(f.main.id);
    expect(result.bindInput.permissionMode).toBe("default");
    result.bindInput.sessionId = "forged";
    result.descriptor.revision = "forged";
    expect(f.bridge.getWindowSource(f.main.webContents, f.target).bindInput.sessionId).toBe(
      "session-1",
    );
    expect(f.resource.descriptor.revision).toBe("r1");
    expect(() => f.bridge.getWindowSource(f.other.webContents, f.target)).toThrow(/source/);
    expect(() => f.bridge.getWindowSource(f.popup.webContents, f.target)).toThrow(/untrusted/);
    expect(() =>
      f.bridge.getWindowSource(f.main.webContents, { ...f.target, tabId: "wrong" }),
    ).toThrow();
    f.setBound(false);
    expect(() => f.bridge.getWindowSource(f.main.webContents, f.target)).toThrow(/no longer bound/);
  });

  test("binds before navigation, keeps physical dialogs and logical Session ownership separate", async () => {
    const f = await fixture();
    f.detached.url = "";
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    const derived = f.bridge.guests.get(f.detached.id);
    expect(f.detached.sent).toHaveLength(0);
    expect(derived.ownerWindowId).toBe(f.popup.id);
    expect(derived.logicalOwnerWebContentsId).toBe(f.main.webContents.id);
    expect(derived.context.sessionId).toBe("session-1");
    expect(derived.context.visible).toBe(true);
    expect(f.bridge.agentTaskOwner(derived).ownerWebContentsId).toBe(f.main.webContents.id);
    expect(
      f.bridge.findAgentToolBinding(f.target.appDescriptorId, f.input.bucket, f.popup.id),
    ).toBeUndefined();
    expect(
      f.bridge.findAgentToolBinding(f.target.appDescriptorId, f.input.bucket, f.main.id).guest,
    ).toBe(f.dock);
    await expect(
      f.bridge.bindGuest(f.popup.webContents, { ...f.input, guestId: f.detached.id }),
    ).rejects.toThrow(/does not belong/);
    expect(() =>
      f.bridge.getWindowSource(f.main.webContents, { ...f.target, tabId: "forged" }),
    ).toThrow();
    await expect(f.bridge.bindWindowGuest(f.dock.id, f.detached.id)).rejects.toThrow(/dock source/);
    f.detached.url = "cspanel://fixture/app/index.html";
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    expect(f.detached.sent).toHaveLength(1);
  });

  test("rejects mismatched app, revision or project registrations", async () => {
    for (const field of ["app", "revision", "project"] as const) {
      const f = await fixture();
      const derived = f.bridge.guests.get(f.detached.id);
      if (field === "project") derived.projectPath = "/other";
      else
        derived.resource = {
          ...derived.resource,
          descriptor: {
            ...derived.resource.descriptor,
            [field === "app" ? "id" : "revision"]: "wrong",
          },
        };
      await expect(f.bridge.bindWindowGuest(f.detached.id, f.dock.id)).rejects.toThrow(
        /does not match/,
      );
      expect(derived.windowSourceGuestId).toBeUndefined();
    }
  });

  test("syncs trusted execution settings and shares the source submission reservation", async () => {
    const f = await fixture();
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    const changes: unknown[] = [];
    const cleanup = f.bridge.subscribeWindowSource(
      f.dock.id,
      () => {
        changes.push(true);
        void f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
      },
      () => {},
    );
    await f.bridge.bindGuest(f.main.webContents, {
      ...f.input,
      modelKey: "updated-model",
      permissionMode: "acceptEdits",
      busy: true,
    });
    const derived = f.bridge.guests.get(f.detached.id);
    expect(derived.execution.modelKey).toBe("updated-model");
    expect(derived.execution.permissionMode).toBe("acceptEdits");
    expect(derived.context.busy).toBe(true);
    await expect(f.bridge.submitPrompt(derived, { prompt: "wait" })).rejects.toThrow(/busy/);
    await f.bridge.bindGuest(f.main.webContents, { ...f.input, modelKey: "updated-model" });
    expect(await f.bridge.submitPrompt(derived, { prompt: "run" })).toMatchObject({
      accepted: true,
    });
    expect(f.claims).toEqual([["session-1", f.main.webContents.id]]);
    expect(f.runs[0]![1]).toMatchObject({ sessionId: "session-1", model: "updated-model" });
    await expect(
      f.bridge.submitPrompt(f.bridge.guests.get(f.dock.id), { prompt: "duplicate" }),
    ).rejects.toThrow(/busy/);
    f.releases[0]!({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.bridge.guests.get(f.dock.id).agentSubmitInFlight).toBe(false);
    expect(f.errors).toHaveLength(0);
    expect(changes).toHaveLength(2);
    cleanup();
    await f.bridge.bindGuest(f.main.webContents, f.input);
    expect(changes).toHaveLength(2);
  });

  test("context retargeting revokes derived guests before notifying window cleanup", async () => {
    for (const field of ["sessionId", "bucket", "tabId"] as const) {
      const f = await fixture();
      await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
      const derived = f.bridge.guests.get(f.detached.id);
      let revoked = 0;
      f.bridge.subscribeWindowSource(
        f.dock.id,
        () => {
          throw new Error("must not update");
        },
        () => {
          expect(f.bridge.guests.has(f.detached.id)).toBe(false);
          revoked++;
        },
      );
      await f.bridge.bindGuest(f.main.webContents, { ...f.input, [field]: "different" });
      expect(revoked).toBe(1);
      expect(f.revoked).toContain(f.detached.id);
      expect(() => f.bridge.assertLiveProjectBinding(derived)).toThrow(/no longer bound/);
    }
  });

  test("external runtime submissions retain the main Session owner and trusted settings", async () => {
    const f = await fixture();
    const ensured: any[] = [];
    const sends: any[] = [];
    f.bridge.options.getExternalRuntimeService = () => ({
      isCompatible: () => false,
      ensure: async (input: unknown) => ensured.push(input),
      send: async (...args: unknown[]) => {
        sends.push(args);
        return { ok: true };
      },
    });
    await f.bridge.bindGuest(f.main.webContents, {
      ...f.input,
      modelKey: "codex/gpt-5.6-sol",
      permissionMode: "acceptEdits",
      planMode: true,
    });
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    const derived = f.bridge.guests.get(f.detached.id);
    expect(await f.bridge.submitPrompt(derived, { prompt: "run externally" })).toMatchObject({
      accepted: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ensured).toHaveLength(1);
    expect(ensured[0].ownerWindow).toBe(f.main);
    expect(ensured[0]).toMatchObject({
      sessionId: "session-1",
      permissionMode: "acceptEdits",
      planMode: true,
      modelKey: "codex/gpt-5.6-sol",
    });
    expect(sends[0][0]).toBe("session-1");
    expect(f.runs).toHaveLength(0);
    expect(f.claims).toEqual([["session-1", f.main.webContents.id]]);
    expect(f.bridge.guests.get(f.dock.id).agentSubmitInFlight).toBe(false);
    expect(f.errors).toHaveLength(0);
  });

  test("source destruction cascades revocation, while popup close preserves its source", async () => {
    const f = await fixture();
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    let revoked = 0;
    f.bridge.subscribeWindowSource(
      f.dock.id,
      () => {},
      () => {
        revoked++;
      },
    );
    f.bridge.revokeGuest(f.detached.id);
    expect(f.bridge.guests.has(f.dock.id)).toBe(true);
    expect(revoked).toBe(0);
    f.bridge.registerGuest(f.detached, f.popup, f.resource, "/project");
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    f.dock.destroyed = true;
    f.dock.emit("destroyed");
    expect(f.bridge.guests.has(f.detached.id)).toBe(false);
    expect(revoked).toBe(1);
    expect(f.bridge.windowSourceListeners.size).toBe(0);
  });

  test("derived access fails when source selection or logical owner is revoked", async () => {
    const f = await fixture();
    await f.bridge.bindWindowGuest(f.detached.id, f.dock.id);
    const derived = f.bridge.guests.get(f.detached.id);
    f.main.destroyed = true;
    expect(() => f.bridge.assertLiveProjectBinding(derived)).toThrow(/owner window/);
    f.main.destroyed = false;
    f.setSelected(false);
    expect(() => f.bridge.assertLiveProjectBinding(derived)).toThrow(/no longer bound/);
  });
});
