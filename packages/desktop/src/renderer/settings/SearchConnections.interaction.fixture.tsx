// Fresh renderer process: sibling suites mock dialog modules globally.
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";

ensureMiniDom();
const { useSearchConnections } = await import("./useSearchConnections");
const { DialogProvider } = await import("../ui/DialogProvider");
const { ToastProvider } = await import("../ui/ToastProvider");
const scenario = process.argv[2];
let stored: Record<string, any> = {
  search: { provider: "tavily", apiKey: "synthetic-legacy", baseUrl: "https://owned.invalid" },
};
const writes: Array<{ patch: Record<string, any>; resolve: () => void; reject: () => void }> = [];
const heldReads: Array<() => void> = [];
let holdRead = false;
let holdProbe = false;
let releaseProbe: (() => void) | undefined;
let probes = 0;
Object.defineProperty(window, "codeshell", {
  configurable: true,
  value: {
    getSettings: async () => {
      const captured = structuredClone(stored);
      if (holdRead) await new Promise<void>((resolve) => heldReads.push(resolve));
      return captured;
    },
    updateSettings: (_scope: string, patch: Record<string, any>) =>
      new Promise<void>((resolve, reject) => {
        writes.push({
          patch: structuredClone(patch),
          resolve: () => {
            stored = { ...stored, ...patch };
            resolve();
          },
          reject: () => reject(new Error("Owned write failure")),
        });
      }),
    probeSearch: async () => {
      probes += 1;
      if (holdProbe) await new Promise<void>((resolve) => (releaseProbe = resolve));
      return { status: "ok", lastProbedAt: "2026-10-15T00:00:00.000Z" };
    },
  },
});
let current: ReturnType<typeof useSearchConnections>;
function Probe() {
  current = useSearchConnections("user");
  return null;
}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
async function update(action: () => void) {
  await act(async () => {
    action();
    await flushMicrotasks();
  });
}
let unmounted = false;
try {
  await update(() =>
    root.render(
      <DialogProvider>
        <ToastProvider>
          <Probe />
        </ToastProvider>
      </DialogProvider>,
    ),
  );
  assert.equal(current!.loaded, true);
  assert.equal(current!.byProvider.tavily.apiKey, "synthetic-legacy");
  if (scenario === "snapshot-and-duplicate") {
    await update(() => current!.patch("serper", { apiKey: "synthetic-first" }, true));
    await update(() => {
      void current!.save("serper");
      void current!.setDefault("serper");
      void current!.save("tavily");
    });
    assert.equal(writes.length, 1, "Whole-search mutations share one synchronous guard");
    assert.deepEqual(writes[0].patch, {
      search: {
        provider: "tavily",
        apiKey: "synthetic-legacy",
        baseUrl: "https://owned.invalid",
        providers: {
          serper: { apiKey: "synthetic-first" },
          tavily: { apiKey: "synthetic-legacy", baseUrl: "https://owned.invalid" },
        },
      },
    });
    await update(() => current!.patch("serper", { apiKey: "synthetic-newer" }, true));
    await update(() => writes[0].resolve());
    assert.equal(current!.byProvider.serper.apiKey, "synthetic-newer");
    assert.equal(current!.byProvider.serper.dirty, true);
    assert.equal(stored.search.providers.serper.apiKey, "synthetic-first");
    await update(() => void current!.setDefault("serper"));
    await update(() => writes[1].reject());
    assert.equal(current!.defaultProvider, "tavily", "Rejected writes preserve persisted identity");
    assert.equal(current!.byProvider.serper.apiKey, "synthetic-newer");
  } else if (scenario === "read-order") {
    holdRead = true;
    await update(() => void current!.load());
    stored = {
      search: { provider: "serper", providers: { serper: { apiKey: "synthetic-latest" } } },
    };
    await update(() => void current!.load());
    assert.equal(heldReads.length, 2);
    await update(() => heldReads[1]());
    await update(() => current!.patch("serper", { apiKey: "synthetic-edit" }, true));
    await update(() => heldReads[0]());
    assert.equal(current!.defaultProvider, "serper");
    assert.equal(current!.byProvider.serper.apiKey, "synthetic-edit");
    assert.equal(current!.loading, false);
  } else if (scenario === "late-successful-probe") {
    holdProbe = true;
    await update(() => void current!.test("tavily"));
    assert.equal(probes, 1);
    await update(() => current!.patch("tavily", { apiKey: "synthetic-unprobed" }, true));
    await update(() => releaseProbe!());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].patch.search.providers.tavily.apiKey, "synthetic-legacy");
    await update(() => writes[0].resolve());
    assert.equal(current!.byProvider.tavily.apiKey, "synthetic-unprobed");
    assert.equal(
      current!.byProvider.tavily.probe,
      undefined,
      "Old probe cannot certify new credentials",
    );
    assert.equal(current!.byProvider.tavily.dirty, true);
  } else if (scenario === "unmounted-probe") {
    holdProbe = true;
    await update(() => void current!.test("tavily"));
    await update(() => root.unmount());
    unmounted = true;
    await update(() => releaseProbe!());
    assert.equal(writes.length, 0, "A resolved probe cannot persist after its owner unmounts");
  } else throw new Error(`Unknown scenario: ${scenario}`);
} finally {
  if (!unmounted) await update(() => root.unmount());
  document.body.removeChild(container);
}
