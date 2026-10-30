import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type MobileClientEvent,
  type MobileServerEvent,
} from "@cjhyy/code-shell-core";
import { MobileOutputClient } from "../../../../web/src/hooks/mobileOutputClient.js";
import { SessionSnapshotStore } from "../SessionSnapshotStore.js";
import { getProjectStore } from "../project-store.js";
import { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";
import { handleClientEvent, type OrchestratorCtx } from "./handle-client-event.js";
import {
  mobileSessionCommandAuthority,
  mobileOutputRecoveryAuthority,
} from "./output-recovery-authority.js";
import { MobileOutputRecovery } from "./output-recovery.js";

test.each([false, true])(
  "a journal-less Session keeps its verified selection through actual client history fallback (external=%s)",
  async (external) => {
    const home = mkdtempSync(join(tmpdir(), "mobile-native-legacy-"));
    const previousHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = home;
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const project = await getProjectStore().createFromPath(cwd);
    const manager = new SessionManager();
    const session = manager.create(
      cwd,
      external ? "claude-code/fixture" : "fixture-model",
      external ? "claude-code" : "fixture",
    );
    const sessionId = session.state.sessionId;
    manager.migrateSessionMainRoot(
      sessionId,
      { projectId: project.id, mainRootId: project.roots[0]!.id },
      cwd,
    );
    session.transcript.appendMessage("user", "Synthetic earlier question");
    session.transcript.appendMessage("assistant", "Synthetic saved answer");
    const statePath = join(manager.getStorageDir(), sessionId, "state.json");
    const stateMetadata = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...stateMetadata, status: "completed" }));
    const outbound: MobileClientEvent[] = [];
    const sent: MobileClientEvent[] = [];
    const replies: MobileServerEvent[] = [];
    const failures: string[] = [];
    const snapshots = new SessionSnapshotStore();
    const commands = new MobileExternalRuntimeCommands({
      authenticated: (viewer, device) => viewer === "tab" && device === "phone",
      authority: mobileSessionCommandAuthority,
      owner: () => undefined,
      service: () => null,
      isExternal: () => external,
      exists: (id) => manager.exists(id),
      attachmentPath: async (path) => path,
    });
    const send = (event: MobileClientEvent) => {
      outbound.push(event);
      sent.push(event);
      return true;
    };
    const client = new MobileOutputClient({
      send,
      current: () => ({ sessionId, revision: 1 }),
      commit: () => failures.push("unexpected journal hydration"),
      failed: (id) => failures.push(id),
      legacy: (id) => send({ type: "session.history", sessionId: id }),
    });
    const reply = (_recipient: string, event: MobileServerEvent) => {
      replies.push(event);
      client.observe(event);
    };
    const recovery = new MobileOutputRecovery({
      root: () => manager.getStorageDir(),
      authority: mobileOutputRecoveryAuthority,
      snapshot: (id, since) => snapshots.get(id, since),
      reply,
      authenticated: (viewer, device) => viewer === "tab" && device === "phone",
      journalRequired: () => external,
    });
    const state = {};
    const ctx = {
      externalCommands: commands,
      outputRecovery: recovery,
      getBridge: () => ({
        getLastRunContext: () => ({}),
        getSnapshot: (id: string, since?: number) => snapshots.get(id, since),
      }),
      deviceState: () => state,
      lookupDiskSessionCwd: async (id: string) => manager.readSessionState(id)?.cwd,
      sendMobilePermissionMode() {},
      replayPendingMobileApprovals() {},
      remote: { sendToViewer: reply, sendToDevice: reply },
    } as unknown as OrchestratorCtx;
    try {
      client.observe({
        type: "auth.ok",
        capabilities: { outputJournal: 1, legacyBasePages: 1 },
      } as never);
      client.begin(sessionId);
      for (let count = 0; count < 20; count++) {
        await Promise.resolve();
        const event = outbound.shift();
        if (!event) {
          // The client composes asynchronous recovery stages; an empty tick does
          // not mean it has finished the native fallback handshake.
          if (replies.some((reply) => reply.type === "session.history.ok")) break;
          continue;
        }
        await handleClientEvent(ctx, { ...event, viewerId: "tab", deviceId: "phone" });
      }
      expect(failures).toEqual([]);
      expect(sent.map((event) => event.type)).toEqual([
        "session.select",
        "session.outputJournal",
        ...(external ? ["session.legacyBase"] : []),
        "session.history",
      ]);
      expect(replies.some((event) => event.type === "error")).toBe(false);
      const history = replies.find((event) => event.type === "session.history.ok");
      expect(history).toBeDefined();
      expect(JSON.stringify(history)).toContain("Synthetic earlier question");
      expect(JSON.stringify(history)).toContain("Synthetic saved answer");
      expect(commands.isExternal(sessionId, "tab")).toBe(external);
      await handleClientEvent(ctx, {
        type: "session.sync",
        sessionId,
        viewerId: "tab",
        deviceId: "phone",
      });
      expect(replies.at(-1)).toMatchObject({
        type: external ? "session.history.ok" : "session.snapshot",
        sessionId,
      });
      // A later explicit transition still revokes the independent command grant.
      await commands.observe({
        type: "room.open",
        roomId: "other-room",
        viewerId: "tab",
        deviceId: "phone",
      });
      expect(commands.isExternal(sessionId, "tab")).toBe(true);
    } finally {
      client.cancel(false);
      recovery.revoke("tab");
      await getProjectStore().remove(project.id);
      if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  },
);
