import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerOptimizationLabIpc } from "./optimization-lab-ipc";
import { isOptimizationLabQuery, unwrapOptimizationLabReply } from "../shared/optimization-lab";
import { buildEvidenceBundle } from "@cjhyy/code-shell-capability-optimization-lab";

const roots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const datasetTarget = { target: { projectId: "project" } };
async function fileRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lab-dataset-files-"));
  roots.push(root);
  return root;
}

describe("Optimization Lab editable dataset files", () => {
  test("imports exact UTF-8 text including BOM and invalid JSON without any worker request", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const source = join(root, "draft.json");
    const text = '\ufeff{\r\n  "title": "样本 🐈",\r\n  unfinished\r\n';
    await writeFile(source, text);
    fixture.select(source);
    expect(await fixture.invoke("importDataset", datasetTarget)).toBe(text);
    expect(fixture.calls).toHaveLength(0);
  });

  test("empty text is an editable draft and cancelled dialogs have no side effects", async () => {
    const fixture = setup();
    expect(await fixture.invoke("importDataset", datasetTarget)).toBeNull();
    expect(await fixture.invoke("exportDataset", { ...datasetTarget, text: "draft" })).toBe(false);
    const root = await fileRoot();
    const source = join(root, "empty.json");
    await writeFile(source, "");
    fixture.select(source);
    expect(await fixture.invoke("importDataset", datasetTarget)).toBe("");
    expect(fixture.calls).toHaveLength(0);
    expect(await readdir(root)).toEqual(["empty.json"]);
  });

  test("exports original invalid JSON verbatim and replaces a regular file without modifying hard links", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const destination = join(root, "draft.json");
    const linked = join(root, "prior-copy.json");
    await writeFile(destination, "prior");
    await link(destination, linked);
    fixture.select(destination);
    const text = '\ufeff{\n "draft": "样本",\n';
    expect(await fixture.invoke("exportDataset", { ...datasetTarget, text })).toBe(true);
    expect(await readFile(destination, "utf8")).toBe(text);
    expect(await readFile(linked, "utf8")).toBe("prior");
    expect(fixture.fileDialogs).toEqual(["optimization-dataset.json"]);
    expect(fixture.calls).toHaveLength(0);
    expect((await readdir(root)).sort()).toEqual(["draft.json", "prior-copy.json"]);
    if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  test("enforces the 16 MiB byte limit without counting JSON string escaping as file bytes", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const destination = join(root, "draft.json");
    fixture.select(destination);
    const text = '"'.repeat(16 * 1024 * 1024);
    expect(await fixture.invoke("exportDataset", { ...datasetTarget, text })).toBe(true);
    expect((await stat(destination)).size).toBe(16 * 1024 * 1024);
    expect(await fixture.invoke("importDataset", datasetTarget)).toBe(text);
    await expect(
      fixture.invoke("exportDataset", { ...datasetTarget, text: `${text}x` }),
    ).rejects.toThrow("bounded");
    await truncate(destination, 16 * 1024 * 1024 + 1);
    await expect(fixture.invoke("importDataset", datasetTarget)).rejects.toThrow("bounded");
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects invalid UTF-8 instead of silently replacing bytes", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const source = join(root, "invalid.json");
    await writeFile(source, Buffer.from([0x22, 0xff, 0x22]));
    fixture.select(source);
    await expect(fixture.invoke("importDataset", datasetTarget)).rejects.toThrow();
    await expect(
      fixture.invoke("exportDataset", { ...datasetTarget, text: "\ud800" }),
    ).rejects.toThrow("UTF-8");
    expect(await readFile(source)).toEqual(Buffer.from([0x22, 0xff, 0x22]));
    expect(fixture.calls).toHaveLength(0);
  });

  test("refuses source symlinks, directories and relative selected paths", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const source = join(root, "source.json");
    const linked = join(root, "link.json");
    await writeFile(source, "{}");
    await symlink(source, linked);
    for (const path of [linked, root, "relative.json"]) {
      fixture.select(path);
      await expect(fixture.invoke("importDataset", datasetTarget)).rejects.toThrow();
    }
    expect(fixture.calls).toHaveLength(0);
  });

  for (const operation of ["importDataset", "exportDataset"] as const) {
    test(`${operation} rejects untrusted projects and malformed payloads before opening a dialog`, async () => {
      const fixture = setup();
      const input =
        operation === "importDataset" ? datasetTarget : { ...datasetTarget, text: "{}" };
      fixture.trust(false);
      await expect(fixture.invoke(operation, input)).rejects.toThrow("trusted");
      fixture.trust(true);
      fixture.kind("workspace");
      await expect(fixture.invoke(operation, input)).rejects.toThrow("trusted");
      fixture.kind("project");
      for (const value of [
        null,
        [],
        { ...input, path: "/arbitrary.json" },
        { ...input, cwd: "/evil" },
      ])
        await expect(fixture.invoke(operation, value)).rejects.toThrow();
      await expect(
        fixture.invoke(operation, { ...input, target: { cwd: "/evil" } }),
      ).rejects.toThrow("stable");
      await expect(fixture.invoke(operation, input, {})).rejects.toThrow();
      fixture.enable(false);
      expect(() => fixture.invoke(operation, input)).toThrow("disabled");
      const handler = fixture.handlers.get(`optimizationLab:${operation}`)!;
      expect(() => handler({ ...fixture.event, senderFrame: {} }, input)).toThrow("top frame");
      expect(fixture.fileDialogs).toHaveLength(0);
      expect(fixture.calls).toHaveLength(0);
    });

    for (const change of [
      "disable",
      "untrust",
      "primary",
      "kind",
      "destroy",
      "unregister",
      "navigate",
    ] as const) {
      test(`${operation} rechecks ${change} after the native file dialog`, async () => {
        const fixture = setup();
        const root = await fileRoot();
        const source = join(root, "source.json");
        await writeFile(source, "original");
        fixture.select(source);
        fixture.duringFileDialog(() => {
          if (change === "disable") fixture.enable(false);
          else if (change === "untrust") fixture.trust(false);
          else if (change === "primary") fixture.primary("/another/primary");
          else if (change === "kind") fixture.kind("workspace");
          else fixture[change]();
        });
        const input =
          operation === "importDataset" ? datasetTarget : { ...datasetTarget, text: "replacement" };
        await expect(fixture.invoke(operation, input)).rejects.toThrow();
        expect(await readFile(source, "utf8")).toBe("original");
        expect(await readdir(root)).toEqual(["source.json"]);
        expect(fixture.calls).toHaveLength(0);
      });
    }
  }

  test("rejects a different selected inode or a source that grows between inspection and open", async () => {
    const root = await fileRoot();
    for (const change of ["replace", "grow"] as const) {
      const fixture = setup();
      const source = join(root, `${change}.json`);
      await writeFile(source, "{}");
      fixture.select(source);
      const actualOpen = fs.open;
      const spy = spyOn(fs, "open").mockImplementationOnce(async (...args: any[]) => {
        if (change === "replace") {
          await rename(source, `${source}.prior`);
          await writeFile(source, "{}");
        } else await appendFile(source, "changed");
        return (actualOpen as any)(...args);
      });
      spies.push(spy);
      await expect(fixture.invoke("importDataset", datasetTarget)).rejects.toThrow("changed");
      expect(fixture.calls).toHaveLength(0);
      spy.mockRestore();
    }
  });

  test("rejects a file that grows during the bounded read", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const source = join(root, "source.json");
    await writeFile(source, "{}");
    fixture.select(source);
    const actualOpen = fs.open;
    const spy = spyOn(fs, "open").mockImplementationOnce(async (...args: any[]) => {
      const handle = await (actualOpen as any)(...args);
      const read = handle.read.bind(handle);
      let first = true;
      handle.read = async (...readArgs: any[]) => {
        if (first) {
          first = false;
          await appendFile(source, "changed");
        }
        return read(...readArgs);
      };
      return handle;
    });
    spies.push(spy);
    await expect(fixture.invoke("importDataset", datasetTarget)).rejects.toThrow("changed");
    expect(fixture.calls).toHaveLength(0);
  });

  test("rejects exports to frozen artifacts, symlinks, directories and missing parents", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const store = join(root, "optimization-lab");
    const artifact = join(store, "project", "datasets", "hash", "manifest.json");
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(artifact, "immutable");
    fixture.protect(store);
    const external = join(root, "external.json");
    await writeFile(external, "preserve");
    const linked = join(root, "link.json");
    await symlink(external, linked);
    const dangling = join(root, "dangling.json");
    await symlink(join(root, "missing.json"), dangling);
    const alias = join(root, "store-alias");
    await symlink(store, alias, "dir");
    for (const path of [
      artifact,
      join(alias, "project", "datasets", "hash", "manifest.json"),
      linked,
      dangling,
      root,
      join(root, "missing", "draft.json"),
      "relative.json",
    ]) {
      fixture.select(path);
      await expect(
        fixture.invoke("exportDataset", { ...datasetTarget, text: "new" }),
      ).rejects.toThrow();
    }
    expect(await readFile(artifact, "utf8")).toBe("immutable");
    expect(await readFile(external, "utf8")).toBe("preserve");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fixture.calls).toHaveLength(0);
  });

  test("a destination swap during export is rejected and its symlink target stays untouched", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const destination = join(root, "draft.json");
    const external = join(root, "external.json");
    await writeFile(destination, "original");
    await writeFile(external, "preserve");
    fixture.select(destination);
    const actualWrite = fs.writeFile;
    const spy = spyOn(fs, "writeFile").mockImplementationOnce(async (...args: any[]) => {
      await (actualWrite as any)(...args);
      await rm(destination);
      await symlink(external, destination);
    });
    spies.push(spy);
    await expect(
      fixture.invoke("exportDataset", { ...datasetTarget, text: "new" }),
    ).rejects.toThrow("changed");
    expect(await readFile(external, "utf8")).toBe("preserve");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("disabling while a draft is being written aborts publication and cleans the temporary file", async () => {
    const fixture = setup();
    const root = await fileRoot();
    const destination = join(root, "draft.json");
    await writeFile(destination, "original");
    fixture.select(destination);
    const actualWrite = fs.writeFile;
    const spy = spyOn(fs, "writeFile").mockImplementationOnce(async (...args: any[]) => {
      await (actualWrite as any)(...args);
      fixture.enable(false);
    });
    spies.push(spy);
    await expect(
      fixture.invoke("exportDataset", { ...datasetTarget, text: "new" }),
    ).rejects.toThrow(/no longer|disabled/);
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await readdir(root)).toEqual(["draft.json"]);
    expect(fixture.calls).toHaveLength(0);
  });

  test("disposing removes both dataset file channels", () => {
    const fixture = setup();
    expect(fixture.handlers.has("optimizationLab:importDataset")).toBe(true);
    expect(fixture.handlers.has("optimizationLab:exportDataset")).toBe(true);
    fixture.dispose();
    expect(fixture.handlers.size).toBe(0);
  });
});
const hash = "a".repeat(64);
function setup() {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const sender = { id: 1, mainFrame: {} };
  const window = { isDestroyed: () => false, webContents: sender };
  const event = { sender, senderFrame: sender.mainFrame };
  const calls: Array<{ type: string; params: any }> = [];
  let enabled = true,
    trusted = true,
    confirmed = 1;
  let selectedFile: string | undefined;
  let confirming: (() => void) | undefined;
  let selecting: (() => void) | undefined;
  let resolving: (() => void) | undefined;
  let destroyed = false;
  let registered = true;
  let primary = "/authoritative/primary";
  let targetKind = "project";
  let artifactRoot = "/authoritative/optimization-lab";
  const fileDialogs: string[] = [];
  window.isDestroyed = () => destroyed;
  const snapshot = {
    id: "experiment-1",
    state: { revision: 7, status: "ready" },
    plan: {
      planHash: hash,
      targetConnection: { model: "target" },
      optimizerConnection: { model: "optimizer" },
      externalDataRoles: ["task", "optimizer"],
    },
  };
  const adoptionPreview = {
    id: snapshot.id,
    reportHash: hash,
    body: "Adopt this frozen body",
    sourceRevision: "b".repeat(64),
    skillName: "example",
    scope: { provider: "openai", model: "fixture" },
    receiptIds: ["receipt"],
  };
  const dialogs: any[] = [];
  const evidenceReads: unknown[] = [];
  const dispose = registerOptimizationLabIpc({
    ipc: {
      handle: (channel, handler) => handlers.set(channel, handler as any),
      removeHandler: (channel) => handlers.delete(channel),
    } as any,
    windows: () => (registered ? [window] : []) as any,
    enabled: () => enabled,
    resolveTarget: async (target) => {
      resolving?.();
      if (JSON.stringify(target) !== JSON.stringify({ projectId: "project" }))
        throw new Error("stable project identity required");
      return { kind: targetKind, cwd: primary };
    },
    trusted: async () => trusted,
    artifactRoot: () => artifactRoot,
    query: async (type, params) => {
      calls.push({ type, params });
      if (type.endsWith("adoption_preview")) return structuredClone(adoptionPreview);
      if (type.endsWith("get")) return structuredClone(snapshot);
      if (type.endsWith("discover")) return { connections: [] };
      if (type.endsWith("report"))
        return { hash, json: { verified: false }, markdown: "# Immutable report" };
      return snapshot;
    },
    skills: () => [{ name: "example", source: "project" }],
    evidence: async (cwd, runIds) => {
      evidenceReads.push({ cwd, runIds });
      return buildEvidenceBundle(
        "a".repeat(16),
        runIds.map((runId) => ({
          runId,
          sessionId: null,
          source: "managed_run" as const,
          blocks: [{ kind: "input" as const, eventId: null, text: "Selected input" }],
          missingEvidence: [],
          truncated: false,
        })),
      );
    },
    confirm: async (_window, options) => {
      dialogs.push(options);
      confirming?.();
      return { response: confirmed };
    },
    save: async (_window, name) => {
      fileDialogs.push(name);
      selecting?.();
      return selectedFile;
    },
    choose: async () => {
      fileDialogs.push("choose");
      selecting?.();
      return selectedFile;
    },
  });
  const authorization = {
    target: { projectId: "project" },
    id: snapshot.id,
    planHash: hash,
    expectedRevision: 7,
    operationId: "confirmation-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    limits: {
      maxRequests: 20,
      maxExecutionMs: 120_000,
      maxEstimatedTokens: null,
      maxEstimatedCostUsd: null,
    },
  };
  return {
    handlers,
    event,
    calls,
    evidenceReads,
    dialogs,
    snapshot,
    authorization,
    adoptionPreview,
    dispose,
    fileDialogs,
    enable: (on: boolean) => {
      enabled = on;
    },
    trust: (on: boolean) => {
      trusted = on;
    },
    confirm: (result: number) => {
      confirmed = result;
    },
    duringConfirmation: (action: () => void) => {
      confirming = action;
    },
    duringFileDialog: (action: () => void) => {
      selecting = action;
    },
    duringResolve: (action: () => void) => {
      resolving = action;
    },
    destroy: () => {
      destroyed = true;
    },
    unregister: () => {
      registered = false;
    },
    navigate: () => {
      sender.mainFrame = {};
    },
    primary: (cwd: string) => {
      primary = cwd;
    },
    kind: (kind: string) => {
      targetKind = kind;
    },
    protect: (path: string) => {
      artifactRoot = path;
    },
    select: (file: string | undefined) => {
      selectedFile = file;
    },
    invoke: (channel: string, ...args: any[]) =>
      handlers.get(`optimizationLab:${channel}`)!(event as any, ...args),
  };
}

describe("Optimization Lab trusted Desktop bridge", () => {
  test("navigation during target resolution is rejected before source/worker access or dialogs", async () => {
    for (const channel of ["query", "previewEvidence", "importDataset", "authorize"] as const) {
      const f = setup();
      f.duringResolve(() => f.navigate());
      const args =
        channel === "query"
          ? ["discover", datasetTarget]
          : channel === "previewEvidence"
            ? [{ ...datasetTarget, runIds: ["selected"] }]
            : channel === "authorize"
              ? [f.authorization]
              : [datasetTarget];
      await expect(f.invoke(channel, ...args)).rejects.toThrow("top frame");
      expect(f.calls).toHaveLength(0);
      expect(f.evidenceReads).toHaveLength(0);
      expect(f.dialogs).toHaveLength(0);
      expect(f.fileDialogs).toHaveLength(0);
    }
  });
  test("a new top frame in the same window cannot import the prior frame's preview receipt", async () => {
    const f = setup();
    const preview = await f.invoke("previewEvidence", { ...datasetTarget, runIds: ["chosen"] });
    f.navigate();
    await expect(
      f.handlers.get("optimizationLab:importEvidence")!(
        { ...f.event, senderFrame: f.event.sender.mainFrame },
        { ...datasetTarget, previewId: preview.previewId, bundleHash: preview.bundle.bundleHash },
      ),
    ).rejects.toThrow("expired or changed");
    expect(f.calls).toHaveLength(0);
  });
  test("selected evidence preview sends nothing to worker and only its native-confirmed receipt can import", async () => {
    const f = setup();
    await expect(f.invoke("query", "import_evidence", datasetTarget)).rejects.toThrow(
      "Unsupported",
    );
    const preview = await f.invoke("previewEvidence", { ...datasetTarget, runIds: ["chosen-run"] });
    expect(f.evidenceReads).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
    const input = {
      ...datasetTarget,
      previewId: preview.previewId,
      bundleHash: preview.bundle.bundleHash,
    };
    await expect(
      f.invoke("importEvidence", { ...input, bundleHash: "f".repeat(64) }),
    ).rejects.toThrow("expired or changed");
    f.confirm(0);
    expect(await f.invoke("importEvidence", input)).toBeNull();
    expect(f.calls).toHaveLength(0);
    f.confirm(1);
    await f.invoke("importEvidence", input);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.type).toBe("optimization_lab_import_evidence");
    expect(f.calls[0]!.params.bundle).toEqual(preview.bundle);
    await expect(f.invoke("importEvidence", input)).rejects.toThrow("expired or changed");
  });
  test("evidence receipts are invalidated by a newer preview, project change, revoked trust or frame navigation", async () => {
    for (const change of ["preview", "project", "trust", "frame"] as const) {
      const f = setup();
      const preview = await f.invoke("previewEvidence", { ...datasetTarget, runIds: ["chosen"] });
      const input = {
        ...datasetTarget,
        previewId: preview.previewId,
        bundleHash: preview.bundle.bundleHash,
      };
      f.confirm(1);
      if (change === "preview")
        await f.invoke("previewEvidence", { ...datasetTarget, runIds: ["new"] });
      if (change === "project") f.primary("/other/project");
      if (change === "trust") f.duringConfirmation(() => f.trust(false));
      if (change === "frame") f.duringConfirmation(() => f.navigate());
      await expect(f.invoke("importEvidence", input)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });
  test("unwraps the actual agent/query type+data envelope and refuses mismatched responses", () => {
    const data = { connections: [] };
    expect(
      unwrapOptimizationLabReply("optimization_lab_discover", {
        type: "optimization_lab_discover",
        data,
      }),
    ).toBe(data);
    expect(() =>
      unwrapOptimizationLabReply("optimization_lab_discover", { connections: [] }),
    ).toThrow("Mismatched");
    expect(() =>
      unwrapOptimizationLabReply("optimization_lab_grant", { type: "optimization_lab_get", data }),
    ).toThrow("Mismatched");
  });
  test("rejects non-top-frame, flag-off, arbitrary paths and untrusted projects before worker access", async () => {
    const fixture = setup();
    const handler = fixture.handlers.get("optimizationLab:query")!;
    expect(() =>
      handler({ ...fixture.event, senderFrame: {} }, "discover", {
        target: { projectId: "project" },
      }),
    ).toThrow("top frame");
    fixture.enable(false);
    expect(() => fixture.invoke("query", "discover", { target: { projectId: "project" } })).toThrow(
      "disabled",
    );
    fixture.enable(true);
    await expect(
      fixture.invoke("query", "discover", { target: { projectId: "project" }, cwd: "/evil" }),
    ).rejects.toThrow("cwd");
    await expect(fixture.invoke("query", "discover", { target: { cwd: "/evil" } })).rejects.toThrow(
      "stable",
    );
    fixture.trust(false);
    await expect(
      fixture.invoke("query", "discover", { target: { projectId: "project" } }),
    ).rejects.toThrow("trusted");
    expect(fixture.calls).toHaveLength(0);
  });
  test("only allowlisted queries can cross and discovery merges Main-owned skill catalog", async () => {
    const fixture = setup();
    for (const type of ["grant", "optimization_lab_grant", "unknown"])
      await expect(
        fixture.invoke("query", type, { target: { projectId: "project" } }),
      ).rejects.toThrow("Unsupported");
    expect(fixture.calls).toHaveLength(0);
    expect(await fixture.invoke("query", "discover", { target: { projectId: "project" } })).toEqual(
      { connections: [], skills: [{ name: "example", source: "project" }] },
    );
    expect(fixture.calls[0]).toEqual({
      type: "optimization_lab_discover",
      params: { cwd: "/authoritative/primary" },
    });
  });
  test("cancelled native confirmation never grants or starts; renderer confirmation booleans are rejected", async () => {
    const fixture = setup();
    fixture.confirm(0);
    expect(await fixture.invoke("authorize", fixture.authorization)).toBeNull();
    expect(fixture.calls.map((call) => call.type)).toEqual(["optimization_lab_get"]);
    expect(fixture.dialogs[0].detail).toContain(hash);
    expect(fixture.dialogs[0].detail).toContain("unknown");
    await expect(
      fixture.invoke("authorize", { ...fixture.authorization, confirmed: true }),
    ).rejects.toThrow("confirmed");
  });
  test("native confirmation binds hash and revision and grants without starting", async () => {
    const fixture = setup();
    Object.assign(fixture.snapshot.plan, { runnerVersion: "codeshell_isolated_v1" });
    await fixture.invoke("authorize", fixture.authorization);
    expect(fixture.dialogs[0].detail).toContain("Isolated ephemeral Engine/Session");
    expect(fixture.dialogs[0].detail).toContain("no tools");
    expect(fixture.calls.map((call) => call.type)).toEqual([
      "optimization_lab_get",
      "optimization_lab_get",
      "optimization_lab_grant",
    ]);
    expect(fixture.calls[2].params).toEqual({
      ...Object.fromEntries(
        Object.entries(fixture.authorization).filter(([key]) => key !== "target"),
      ),
      cwd: "/authoritative/primary",
    });
  });
  test("concurrent state changes or disabling while confirmation is open invalidates approval", async () => {
    const changed = setup();
    changed.duringConfirmation(() => {
      changed.snapshot.state.revision++;
    });
    await expect(changed.invoke("authorize", changed.authorization)).rejects.toThrow("changed");
    expect(changed.calls.every((call) => call.type !== "optimization_lab_grant")).toBe(true);
    const disabled = setup();
    disabled.duringConfirmation(() => disabled.enable(false));
    await expect(disabled.invoke("authorize", disabled.authorization)).rejects.toThrow(
      /no longer|disabled/,
    );
    expect(disabled.calls.every((call) => call.type !== "optimization_lab_grant")).toBe(true);
  });
  test("grading imports use native file selection, reject symlinks and preserve exact revision", async () => {
    const fixture = setup();
    const root = await mkdtemp(join(tmpdir(), "lab-ipc-"));
    roots.push(root);
    const path = join(root, "grades.json");
    await writeFile(path, JSON.stringify({ reviewer: "human", items: [] }));
    const link = join(root, "linked.json");
    await symlink(path, link);
    fixture.select(link);
    await expect(
      fixture.invoke("importGrading", {
        target: { projectId: "project" },
        id: "experiment-1",
        expectedRevision: 7,
      }),
    ).rejects.toThrow();
    expect(fixture.calls).toHaveLength(0);
    fixture.select(path);
    await fixture.invoke("importGrading", {
      target: { projectId: "project" },
      id: "experiment-1",
      expectedRevision: 7,
    });
    expect(fixture.calls).toEqual([
      {
        type: "optimization_lab_import_grading",
        params: {
          cwd: "/authoritative/primary",
          id: "experiment-1",
          expectedRevision: 7,
          grading: { reviewer: "human", items: [] },
        },
      },
    ]);
  });
  test("generic RPC guard covers every lab operation, while ordinary queries remain unchanged", () => {
    for (const type of ["grant", "start", "prepare", "report"])
      expect(
        isOptimizationLabQuery({
          method: "agent/query",
          params: { type: `optimization_lab_${type}` },
        }),
      ).toBe(true);
    expect(isOptimizationLabQuery({ method: "agent/query", params: { type: "goalGet" } })).toBe(
      false,
    );
    expect(
      isOptimizationLabQuery({ method: "agent/run", params: { type: "optimization_lab_grant" } }),
    ).toBe(false);
  });
});

describe("Optimization Lab scoped native adoption", () => {
  const request = {
    target: { projectId: "project" },
    id: "experiment-1",
    reportHash: hash,
    scope: { kind: "project" },
  };
  test("only the dedicated native channel can adopt an exact preview", async () => {
    const f = setup();
    await expect(f.invoke("query", "adopt", request)).rejects.toThrow("Unsupported");
    await f.invoke("adopt", request);
    expect(f.calls.map((call) => call.type)).toEqual([
      "optimization_lab_adoption_preview",
      "optimization_lab_adoption_preview",
      "optimization_lab_adopt",
    ]);
    expect(f.calls.at(-1)!.params).toEqual({
      cwd: "/authoritative/primary",
      id: "experiment-1",
      reportHash: hash,
    });
    expect(f.dialogs[0].detail).toContain("Adopt this frozen body");
    expect(f.dialogs[0].detail).toContain("no-tools");
  });
  test("cancelled confirmation and changed evidence never adopt", async () => {
    const cancelled = setup();
    cancelled.confirm(0);
    expect(await cancelled.invoke("adopt", request)).toBeNull();
    expect(cancelled.calls).toHaveLength(1);
    const changed = setup();
    changed.duringConfirmation(() => {
      changed.adoptionPreview.body = "Changed body";
    });
    await expect(changed.invoke("adopt", request)).rejects.toThrow("changed");
    expect(changed.calls.some((call) => call.type === "optimization_lab_adopt")).toBe(false);
  });
  test("requires explicit scope and rechecks feature/project after confirmation", async () => {
    const f = setup();
    await expect(f.invoke("adopt", { ...request, scope: { kind: "global" } })).rejects.toThrow(
      "explicit",
    );
    await expect(f.invoke("adopt", { ...request, scope: { kind: "session" } })).rejects.toThrow(
      "explicit",
    );
    f.duringConfirmation(() => f.enable(false));
    await expect(f.invoke("adopt", request)).rejects.toThrow();
    expect(f.calls.some((call) => call.type === "optimization_lab_adopt")).toBe(false);
  });
});
