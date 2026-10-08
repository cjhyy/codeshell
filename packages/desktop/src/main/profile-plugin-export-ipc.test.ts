import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveWorkspaceProfile } from "@cjhyy/code-shell-core/internal";
import { registerProfilePluginExportIpc } from "./profile-plugin-export-ipc.js";

let root: string, cwd: string, previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeshell-plugin-ipc-"));
  cwd = join(root, "project");
  mkdirSync(join(cwd, ".code-shell", "skills", "selected"), { recursive: true });
  writeFileSync(
    join(cwd, ".code-shell", "skills", "selected", "SKILL.md"),
    "---\nname: selected\ndescription: Selected\n---\nREVIEWED\n",
  );
  previous = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "data");
  saveWorkspaceProfile({
    name: "example",
    label: "Example",
    basePreset: "general",
    skills: ["selected"],
  });
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previous;
  rmSync(root, { recursive: true, force: true });
});

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const frame = {};
  let destroy = () => {};
  const sender = {
    id: 42,
    mainFrame: frame,
    once: (_name, fn) => {
      destroy = fn;
    },
  };
  const event = { sender, senderFrame: frame };
  let authority = { kind: "project", projectId: "project", mainRootId: "main-root", cwd };
  let dialogCount = 0;
  let pick: () => Promise<any> = async () => ({ canceled: true });
  let resolver = async (_input: unknown) => authority;
  registerProfilePluginExportIpc(
    { handle: (name, fn) => handlers.set(name, fn) } as any,
    {
      showSaveDialog: async (..._args: unknown[]) => {
        dialogCount++;
        return pick();
      },
    } as any,
    { fromWebContents: () => ({}) } as any,
    (candidate) => candidate === (sender as any),
    ((input) => resolver(input)) as any,
  );
  return {
    call: (name: string, ...args: unknown[]) => handlers.get(`profiles:${name}`)!(event, ...args),
    untrusted: (name: string, ...args: unknown[]) =>
      handlers.get(`profiles:${name}`)!({ ...event, senderFrame: {} }, ...args),
    setPick: (fn: typeof pick) => {
      pick = fn;
    },
    setResolver: (fn: typeof resolver) => {
      resolver = fn;
    },
    changeAuthority: () => {
      authority = { ...authority, mainRootId: "replacement-root" };
    },
    dialogs: () => dialogCount,
    destroy: () => destroy(),
  };
}
const target = { projectId: "project" };
const empty = { componentIds: [], textFileIds: [], includeInstruction: false };
test("no-repo is rejected before the resolver can create its working directory", async () => {
  const h = harness();
  let resolved = 0;
  h.setResolver(async () => {
    resolved++;
    throw new Error("must not resolve");
  });
  await expect(h.call("previewPluginExport", "example", { noRepo: true }, empty)).rejects.toThrow(
    "existing project",
  );
  await expect(
    h.call("commitPluginExport", "a".repeat(36), { noRepo: true }, true),
  ).rejects.toThrow("existing project");
  expect(resolved).toBe(0);
  expect(h.dialogs()).toBe(0);
});
async function selected(h: ReturnType<typeof harness>) {
  const initial = await h.call("previewPluginExport", "example", target, empty);
  return h.call("previewPluginExport", "example", target, {
    ...empty,
    componentIds: [initial.components[0].id],
  });
}

test("main-frame ownership and explicit loss acceptance precede native destination selection", async () => {
  const h = harness();
  expect(() => h.untrusted("cancelPluginExport", "a".repeat(36))).toThrow("main window");
  const preview = await selected(h);
  await expect(h.call("commitPluginExport", preview.reviewToken, target, false)).rejects.toThrow(
    "explicit loss",
  );
  expect(h.dialogs()).toBe(0);
  h.destroy();
  await expect(h.call("commitPluginExport", preview.reviewToken, target, true)).rejects.toThrow(
    "expired",
  );
});

test("native cancel writes nothing; changing context while the native picker is open revokes review", async () => {
  const h = harness();
  const preview = await selected(h);
  expect(await h.call("commitPluginExport", preview.reviewToken, target, true)).toEqual({
    canceled: true,
  });
  expect(existsSync(join(root, "output.plugin"))).toBe(false);
  const next = await selected(h);
  h.setPick(async () => {
    h.changeAuthority();
    return { canceled: false, filePath: join(root, "output.plugin") };
  });
  await expect(h.call("commitPluginExport", next.reviewToken, target, true)).rejects.toThrow(
    "context changed",
  );
  expect(existsSync(join(root, "output.plugin"))).toBe(false);
});

test("cancellation while native picker is pending cannot write an abandoned snapshot", async () => {
  const h = harness();
  const preview = await selected(h);
  let finish: (picked: unknown) => void = () => {};
  h.setPick(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const committed = h.call("commitPluginExport", preview.reviewToken, target, true);
  await Promise.resolve();
  await Promise.resolve();
  h.call("cancelPluginExport", preview.reviewToken);
  finish({ canceled: false, filePath: join(root, "output.plugin") });
  await expect(committed).rejects.toThrow("expired");
  expect(existsSync(join(root, "output.plugin"))).toBe(false);
});

test("an older authority lookup cannot replace a newer context's private preview", async () => {
  const h = harness();
  let resolveOld: (value: any) => void = () => {};
  let count = 0;
  h.setResolver(async () => {
    if (++count === 1)
      return new Promise((done) => {
        resolveOld = done;
      });
    return { kind: "project", projectId: "project", mainRootId: "main-root", cwd };
  });
  const old = h.call("previewPluginExport", "example", target, empty);
  const current = await h.call("previewPluginExport", "example", target, empty);
  resolveOld({ kind: "project", projectId: "project", mainRootId: "old-root", cwd });
  await expect(old).rejects.toThrow("superseded");
  // The current review remains present; it fails for having no component, not expiry.
  await expect(h.call("commitPluginExport", current.reviewToken, target, true)).rejects.toThrow(
    "loadable component",
  );
  h.destroy();
});
