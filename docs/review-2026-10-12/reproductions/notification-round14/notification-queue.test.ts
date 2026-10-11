import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.CODE_SHELL_TEST_HOME) throw new Error("guarded HOME required");
const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\/$/, "");
const { installLocalNetworkGuard } = await import(repo + "/scripts/runtime-cost-smoke-isolation.mjs");
installLocalNetworkGuard("http://127.0.0.1:9");
const { DesktopNotifier } = await import(repo + "/packages/desktop/src/main/desktop-notifier.ts");
const { notifyPetTaskClosure, notifyMissingAutomationResumeTarget, notifyBackgroundResult } = await import(repo + "/packages/desktop/src/main/desktop-notification-routes.ts");
const { agentNotificationBus } = await import(repo + "/packages/core/src/tool-system/builtin/agent-notifications.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw Error("notification fixture did not settle"); await tick(); }
}
function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "codeshell-notification-round14-")); roots.push(root);
  const shown: Array<{ title: string; body: string }> = [];
  const path = join(root, "receipts.json");
  const deps = { hasFocusedWindow: () => false, isSupported: () => true, show: (value: any) => { shown.push(value); }, ...overrides };
  return { path, shown, deps, notifier: new DesktopNotifier(path, deps as any) };
}
const closure = (notifier: any, index: number) => notifyPetTaskClosure(notifier, { deliveryKey: `closure-${index}`, title: `ordinary-${index}`, message: "finished", taskId: `task-${index}` });
const job = { id: "owned-missing-resume", name: "Owned fixture", runCount: 2 } as any;

test("CONFIRMED production urgent missing-target route waits behind an ordinary rate-slot sleep", async () => {
  let now = 100;
  let release: (() => void) | undefined;
  const delays: number[] = [];
  const f = fixture({ now: () => now, sleep: (delay: number) => {
    delays.push(delay);
    return new Promise<void>(resolve => { release = () => { now += delay; resolve(); }; });
  } });
  // Same bus subscription as Main, without Main/worker/native notification startup.
  const unsubscribe = agentNotificationBus.subscribe((envelope: any) => notifyBackgroundResult(f.notifier, envelope));
  try {
    // Keep production defaults: five ordinary shows per 10,000 ms.
    for (let i = 0; i < 6; i++) agentNotificationBus.publish({
      kind: "result", id: `owned-envelope-${i}`, from: { sessionId: "owned-child" }, to: { sessionId: "owned-parent" },
      payload: { workId: `owned-work-${i}`, workKind: "agent", status: "completed", description: `ordinary-${i}`, finishedAt: 100 },
    } as any);
    await until(() => release !== undefined);
    expect(f.shown).toHaveLength(5);
    let urgentSettled = false;
    const urgent = notifyMissingAutomationResumeTarget(f.notifier, job).then(() => { urgentSettled = true; });
    await tick(); await tick();
    expect(delays).toEqual([10_000]);
    expect(f.shown.some(value => value.title === "定时任务已停止")).toBe(false);
    expect(urgentSettled).toBe(false);
    release!();
    await urgent;
    expect(f.shown.slice(0, 6).map(value => value.body)).toEqual(["ordinary-0", "ordinary-1", "ordinary-2", "ordinary-3", "ordinary-4", "ordinary-5"]);
    expect(f.shown[6]?.title).toBe("定时任务已停止");
    expect(urgentSettled).toBe(true);
    expect(delays).toEqual([10_000]);
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveLength(7);
  } finally { unsubscribe(); }
  console.log(JSON.stringify({ productionRateWindowMs: 10_000, productionOrdinaryLimit: 5, urgentEnteredDuringOrdinaryWait: true, urgentShownBeforeRelease: false, releaseAdvancesOnlyInjectedClockMs: 10_000, actualNativeNotification: false }));
});

test("normal urgent route bypasses a saturated budget when no ordinary delivery already owns the queue", async () => {
  const f = fixture({ now: () => 100, sleep: async () => { throw Error("urgent route must not sleep"); } });
  for (let i = 0; i < 5; i++) await closure(f.notifier, i);
  await notifyMissingAutomationResumeTarget(f.notifier, job);
  expect(f.shown).toHaveLength(6);
  expect(f.shown[5]?.title).toBe("定时任务已停止");
  // Same key deduplicates in process and after a store-like restart.
  await notifyMissingAutomationResumeTarget(f.notifier, job);
  const restarted = new DesktopNotifier(f.path, f.deps as any);
  await notifyMissingAutomationResumeTarget(restarted, job);
  expect(f.shown).toHaveLength(6);
});

test("normal focus, unsupported and show failure do not earn a receipt; a later valid retry can display", async () => {
  let focused = true; let supported = true; let fail = false;
  const shown: any[] = [];
  const f = fixture({ hasFocusedWindow: () => focused, isSupported: () => supported, show: (value: any) => { if (fail) throw Error("owned show failure"); shown.push(value); } });
  const input = { key: "retry-key", title: "Result", body: "kept" };
  expect(await f.notifier.notify(input)).toBe("focused");
  focused = false; supported = false;
  expect(await f.notifier.notify(input)).toBe("unsupported");
  supported = true; fail = true;
  expect(await f.notifier.notify(input)).toBe("failed");
  fail = false;
  expect(await f.notifier.notify(input)).toBe("shown");
  expect(await f.notifier.notify(input)).toBe("duplicate");
  expect(shown).toHaveLength(1);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toHaveLength(1);
});
