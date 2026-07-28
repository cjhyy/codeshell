import { describe, expect, test } from "bun:test";
import {
  PanelAppLifecycleRuntime,
  type PanelAppLifecycleEventName,
  type PanelAppLifecycleModule,
} from "./runtime.js";

interface Host {
  log: string[];
}

interface PanelContext {
  cwd: string | null;
  busy: boolean;
}

describe("PanelAppLifecycleRuntime", () => {
  test("coordinates activation and code-backed panel instances", async () => {
    const host: Host = { log: [] };
    const events: PanelAppLifecycleEventName[] = [];
    const module: PanelAppLifecycleModule<Host, PanelContext> = {
      id: "quick-chat",
      hooks: Object.fromEntries(
        [
          "activate",
          "panel_mount",
          "panel_context_changed",
          "panel_visibility_changed",
          "panel_unmount",
          "deactivate",
        ].map((name) => [
          name,
          ({ event }: { event: { type: PanelAppLifecycleEventName } }) => {
            events.push(event.type);
            host.log.push(event.type);
          },
        ]),
      ) as PanelAppLifecycleModule<Host, PanelContext>["hooks"],
    };
    const runtime = new PanelAppLifecycleRuntime<Host, PanelContext>();
    const dispose = runtime.register(module);

    await runtime.mountPanel(
      module.id,
      {
        panelId: "quickChat",
        instanceId: "bucket-a:tab-1",
        context: { cwd: "/repo", busy: false },
        visible: true,
      },
      host,
    );
    // React StrictMode and repeated host binds must not mount twice.
    await runtime.mountPanel(
      module.id,
      {
        panelId: "quickChat",
        instanceId: "bucket-a:tab-1",
        context: { cwd: "/ignored", busy: true },
        visible: false,
      },
      host,
    );
    await runtime.updatePanelContext(
      module.id,
      "bucket-a:tab-1",
      { cwd: "/repo-2", busy: true },
      host,
    );
    await runtime.setPanelVisibility(module.id, "bucket-a:tab-1", false, host);
    await runtime.unmountPanel(module.id, "bucket-a:tab-1", host);
    await runtime.deactivate(module.id, host);

    expect(events).toEqual([
      "activate",
      "panel_mount",
      "panel_context_changed",
      "panel_visibility_changed",
      "panel_unmount",
      "deactivate",
    ]);
    expect(runtime.mountedPanels()).toEqual([]);
    expect(runtime.isActive(module.id)).toBe(false);
    dispose();
  });

  test("isolates hook errors and rejects duplicate module ids", async () => {
    const errors: unknown[] = [];
    const runtime = new PanelAppLifecycleRuntime<Host, PanelContext>({
      onError: ({ error }) => errors.push(error),
    });
    runtime.register({
      id: "broken",
      hooks: {
        activate: [
          () => {
            throw new Error("broken hook");
          },
          ({ host }) => {
            host.log.push("continued");
          },
        ],
      },
    });

    expect(() => runtime.register({ id: "broken" })).toThrow("already registered");
    const host: Host = { log: [] };
    await runtime.activate("broken", host);
    expect(errors).toHaveLength(1);
    expect(host.log).toEqual(["continued"]);
  });
});
