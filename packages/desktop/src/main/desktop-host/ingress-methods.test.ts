import { expect, test } from "bun:test";
import { prepareAgentRunMetadata } from "../agent-run-metadata.js";
import { HostSessionAuthority } from "./authority.js";
import {
  captureRendererRunFacts,
  rendererRunFactReader,
  type RendererRunFacts,
} from "./renderer-run-facts.js";
import { ingressMethods } from "./ingress-methods.js";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";

test("Host rewrites workbench trust from native facts for this exact session and cwd", () => {
  const facts: RendererRunFacts = {};
  const raw = JSON.stringify({
    jsonrpc: "2.0",
    id: "owned",
    method: "agent/run",
    params: {
      sessionId: "session",
      cwd: "/temporary",
      projectTrusted: true,
      task: "run",
      workspaceContext: { projectId: "caller-supplied" },
    },
  });
  const meta = { origin: "renderer" as const, producer: "agent:msg" };
  const expected = prepareAgentRunMetadata(
    raw,
    meta,
    captureRendererRunFacts(
      {
        lookupSession: () => undefined,
        isNoRepoCwd: (path) => path === "/temporary",
        isProjectTrusted: () => false,
      },
      facts,
    ),
  );
  const actual = prepareAgentRunMetadata(raw, meta, rendererRunFactReader(facts));
  expect(actual.outLine).toBe(expected.outLine);
  expect(JSON.parse(actual.outLine).params.projectTrusted).toBe(false);
  expect(JSON.parse(actual.outLine).params.workspaceContext).toBeUndefined();
  expect(() =>
    prepareAgentRunMetadata(
      raw.replace("/temporary", "/elsewhere"),
      meta,
      rendererRunFactReader(facts),
    ),
  ).toThrow();
});

test("admission allows only the initial claim and rejects owner and deletion ABA", () => {
  const sessions = new HostSessionAuthority();
  const a = sessions.captureAdmission("new", 1);
  const b = sessions.captureAdmission("new", 2);
  sessions.setOwner("new", 1);
  expect(() => a.assertCurrent()).not.toThrow();
  expect(() => b.assertCurrent()).toThrow();
  sessions.setOwner("new", null);
  sessions.setOwner("new", 1);
  expect(() => a.assertCurrent()).toThrow();
  const current = sessions.captureAdmission("new", 1);
  sessions.setDeleting("new", true);
  sessions.setDeleting("new", false);
  expect(() => current.assertCurrent()).toThrow();
  a.release?.();
  b.release?.();
});

test("unowned live controls require an owner while new runs pass only after checking visibility", async () => {
  const id = "new";
  const caller: DesktopHostIdentity = {
    webContentsId: 1,
    frameToken: "trusted",
    frameGeneration: 1,
    windowKind: "workbench",
  };
  let seen = 0;
  let delivered = 0;
  const methods = ingressMethods(
    async (request) => {
      delivered++;
      expect(request.identity).toBe(caller);
      return 1;
    },
    async () => {
      seen++;
      return "hidden";
    },
  );
  const ctx = { identity: caller, historical: true, assertCurrent() {} };
  await expect(methods.get("agent/run")!.run(ctx, { sessionId: id })).rejects.toThrow();
  await expect(methods.get("agent/approve")!.run(ctx, { sessionId: id })).rejects.toThrow();
  expect(seen).toBe(1);
  expect(delivered).toBe(0);
  expect(methods.has("desktop/modelRequestSign")).toBe(false);
  expect(() =>
    methods.get("agent/query")!.sessionId!({ type: "config_set", sessionId: id }),
  ).toThrow();
  expect(() => methods.get("agent/configure")!.sessionId!({ credentials: [] })).toThrow();
});
