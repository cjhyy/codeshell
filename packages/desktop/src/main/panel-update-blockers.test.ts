import { expect, test } from "bun:test";
import { PanelExecutionBusyError, panelExecutionGate } from "@cjhyy/code-shell-server/panels";
import {
  panelChangeBlockers,
  panelChangeFailure,
  panelUpdateApproval,
  releasePanelForUpdate,
} from "./panel-update-blockers.js";

test("blockers name the open instance's tab and session and keep Host work by kind", () => {
  const error = new PanelExecutionBusyError("busy", [
    { appId: "fixture", projectPath: "/p", holder: { kind: "panel-call", guestId: 4 }, count: 2 },
    {
      appId: "fixture",
      projectPath: "/p",
      holder: { kind: "tool-job", label: "editor-runtime" },
      count: 1,
    },
  ]);
  const describe = (guestId: number) =>
    guestId === 4 ? { tabId: "tab", bucket: "p::s", sessionId: "s" } : undefined;
  expect(panelChangeBlockers(error, describe)).toEqual([
    { kind: "panel-call", count: 2, tabId: "tab", bucket: "p::s", sessionId: "s" },
    { kind: "tool-job", count: 1, label: "editor-runtime" },
  ]);
  // Other failures, and a change refused while another runs, carry no blockers.
  expect(panelChangeFailure(new Error("other"), describe)).toEqual({});
  expect(panelChangeFailure(new PanelExecutionBusyError("另一个修改"), describe)).toEqual({});
});

test("a forced update waits until closing actually releases the gate, and gives up at its deadline", async () => {
  const project = "/tmp/panel-update-blockers-fixture";
  const matches = (scope: { appId: string }) => scope.appId === "fixture";
  let release = panelExecutionGate.enter({ appId: "fixture", projectPath: project });
  let closed = 0;
  // Release happens as the work exits, after close() itself returns.
  const close = async () => {
    closed++;
    setTimeout(release, 150);
  };
  expect(panelUpdateApproval("fixture", false, close).releaseExecutions).toBeUndefined();
  const approval = panelUpdateApproval("fixture", true, close);
  expect(closed).toBe(0);
  expect(approval.expectedId).toBe("fixture");
  await approval.releaseExecutions!("fixture", matches);
  expect(closed).toBe(1);
  expect(panelExecutionGate.blockers((scope) => scope.appId === "fixture")).toEqual([]);
  release = panelExecutionGate.enter({ appId: "fixture", projectPath: project });
  const started = Date.now();
  await releasePanelForUpdate("fixture", matches, async () => {}, 300);
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(panelExecutionGate.blockers((scope) => scope.appId === "fixture")).toHaveLength(1);
  release();
});
