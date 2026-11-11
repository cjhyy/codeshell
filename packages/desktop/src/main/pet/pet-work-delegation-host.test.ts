import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRecentAttachments, stageImageBytes } from "@cjhyy/code-shell-server/storage";
import { buildInputAttachmentContext } from "../../../../core/src/engine/input-attachments.js";
import { buildDelegationBrief, MAX_DELEGATION_DISPLAY_TEXT_LENGTH } from "./pet-delegation-brief";
import {
  PetWorkDelegationHost,
  petDelegationClientMessageId,
  petDelegationSessionId,
} from "./pet-work-delegation-host";

const DESKTOP_BRIEF = buildDelegationBrief({ origin: "desktop" });

function fakeBridge(
  outcome: "accepted" | "rejected" = "accepted",
  knownSessionIds: readonly string[] = [],
) {
  const lines: string[] = [];
  const announcements: unknown[] = [];
  const reserved: Array<[string, string]> = [];
  const forgotten: string[] = [];
  const listeners = new Set<(line: string) => void>();
  return {
    lines,
    announcements,
    reserved,
    forgotten,
    bridge: {
      subscribeOutbound: (listener: (line: string) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      injectWorkerMessage: (line: string) => {
        lines.push(line);
        const request = JSON.parse(line) as { id: string };
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(
              JSON.stringify(
                outcome === "accepted"
                  ? {
                      jsonrpc: "2.0",
                      method: "agent/runAccepted",
                      params: { requestId: request.id },
                    }
                  : {
                      jsonrpc: "2.0",
                      id: request.id,
                      error: { code: -1, message: "queue rejected" },
                    },
              ),
            );
          }
        });
      },
      hasKnownSession: (sessionId: string) => knownSessionIds.includes(sessionId),
      reserveHostSession: (sessionId: string, cwd: string) => reserved.push([sessionId, cwd]),
      forgetSession: (sessionId: string) => forgotten.push(sessionId),
      broadcastPetDelegationSession: (meta: unknown) => announcements.push(meta),
    },
  };
}

describe("PetWorkDelegationHost", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function stagedInput() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pet-work-image-host-")));
    roots.push(root);
    const managerCwd = join(root, "no-repo");
    const workCwd = join(root, "workspace");
    await Promise.all([mkdir(managerCwd), mkdir(workCwd)]);
    const image = await stageImageBytes({
      cwd: managerCwd,
      sessionId: "pet-manager",
      name: "wechat.png",
      mime: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      origin: "im-gateway",
    });
    return {
      image,
      workCwd,
      inputAttachments: { cwd: managerCwd, sessionId: "pet-manager", attachments: [image] },
    };
  }

  test("submits a new external-default delegation once with prepared images, Goal and permission", async () => {
    const fixture = await stagedInput();
    const fake = fakeBridge("rejected");
    const selections: unknown[] = [];
    const runs: Array<Record<string, any>> = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      channelLabel: () => "微信",
      external: {
        modelKey: async (input) => {
          selections.push(input);
          return "codex/gpt-6.1-sol";
        },
        run: async (params) => {
          runs.push(params);
          return { ok: true };
        },
      },
    });
    const request = {
      clientMessageId: "wechat:external-with-image",
      task: `Diagnose the screenshot ${fixture.image.path}`,
      workspacePath: fixture.workCwd,
      inputAttachments: fixture.inputAttachments,
      goalObjective: "Fix and verify the screenshot error",
      completionTarget: { kind: "im-gateway" as const, channel: "wechat", target: "owner" },
    };
    const [launched, duplicate] = await Promise.all([host.start(request), host.start(request)]);
    expect(duplicate).toEqual(launched);
    expect(selections).toEqual([
      { sessionId: launched.sessionId, cwd: fixture.workCwd, reused: false },
    ]);
    expect(runs).toHaveLength(1);
    expect(fake.lines).toEqual([]);
    expect(runs[0]).toMatchObject({
      sessionId: launched.sessionId,
      cwd: fixture.workCwd,
      model: "codex/gpt-6.1-sol",
      clientMessageId: petDelegationClientMessageId(request.clientMessageId),
      displayText: request.task,
      goal: request.goalObjective,
      permissionMode: "default",
    });
    expect(runs[0]).not.toHaveProperty("requireExisting");
    expect(runs[0]!.task).toContain("from 微信.");
    expect(runs[0]!.attachments).toHaveLength(1);
    expect(runs[0]!.attachments[0]).toMatchObject({ sessionId: launched.sessionId });
    expect(runs[0]!.attachments[0].absPath).toStartWith(fixture.workCwd);
    expect(runs[0]!.task).toContain(runs[0]!.attachments[0].absPath);
    const sent = await listRecentAttachments({
      cwd: fixture.workCwd,
      sessionId: launched.sessionId,
    });
    expect(sent.map((image) => image.absPath)).toEqual([runs[0]!.attachments[0].absPath]);
    expect(fake.reserved).toEqual([[launched.sessionId, fixture.workCwd]]);
    expect(fake.forgotten).toEqual([]);
    expect(fake.announcements).toEqual([
      expect.objectContaining({ sessionId: launched.sessionId, prompt: request.task }),
    ]);
  });

  test("uses the reused Session's selected external route and actual image workspace", async () => {
    const fixture = await stagedInput();
    const actualCwd = join(fixture.workCwd, "actual-worktree");
    await mkdir(actualCwd);
    const fake = fakeBridge("rejected", ["existing-external"]);
    const selections: unknown[] = [];
    const runs: Array<Record<string, any>> = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      resolveSessionCwd: async () => actualCwd,
      external: {
        modelKey: async (input) => {
          selections.push(input);
          return input.reused ? "claude-code/sonnet" : "codex/gpt-6.1-sol";
        },
        run: async (params) => {
          runs.push(params);
          return { ok: true };
        },
      },
    });
    const launched = await host.start({
      clientMessageId: "wechat:reuse-external-image",
      targetSessionId: "existing-external",
      task: `Read ${fixture.image.path}`,
      workspacePath: fixture.workCwd,
      inputAttachments: fixture.inputAttachments,
      goalObjective: "Original objective",
      goalContinuation: { goalId: "persisted-goal", revision: 4 },
    });
    expect(launched.cwd).toBe(actualCwd);
    expect(selections).toEqual([{ sessionId: "existing-external", cwd: actualCwd, reused: true }]);
    expect(runs[0]).toMatchObject({
      sessionId: "existing-external",
      cwd: actualCwd,
      model: "claude-code/sonnet",
      requireExisting: true,
      goalContinuation: { goalId: "persisted-goal", revision: 4 },
    });
    expect(runs[0]).not.toHaveProperty("goal");
    expect(runs[0]!.attachments[0].absPath).toStartWith(
      join(actualCwd, ".code-shell", "attachments", "existing-external"),
    );
    expect(fake.lines).toEqual([]);
    expect(fake.reserved).toEqual([]);
    expect(fake.forgotten).toEqual([]);
  });

  test("a persisted native route stays native even when the reused Session is not in the host map", async () => {
    const fake = fakeBridge();
    const selections: unknown[] = [];
    const externalRuns: unknown[] = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe",
      external: {
        modelKey: async (input) => {
          selections.push(input);
          return input.reused ? "persisted-api-connection" : "codex/gpt-6.1-sol";
        },
        run: async (params) => {
          externalRuns.push(params);
          return { ok: true };
        },
      },
    });
    await host.start({
      clientMessageId: "reuse-native-cold-map",
      targetSessionId: "persisted-native",
      task: "Continue",
      workspacePath: "/work",
    });
    expect(selections).toEqual([{ sessionId: "persisted-native", cwd: "/work", reused: true }]);
    expect(externalRuns).toEqual([]);
    expect(JSON.parse(fake.lines[0]!).params).toMatchObject({
      sessionId: "persisted-native",
      requireExisting: true,
      model: "persisted-api-connection",
    });
  });

  test.each([false, true])(
    "external rejection never falls back to API and preserves known Session=%s",
    async (known) => {
      const id = "wechat:external-rejected";
      const sessionId = petDelegationSessionId(id);
      const fake = fakeBridge("accepted", known ? [sessionId] : []);
      let attempts = 0;
      const host = new PetWorkDelegationHost({
        bridge: fake.bridge,
        noWorkspaceCwd: "/safe",
        external: {
          modelKey: async () => "codex/gpt-6.1-sol",
          run: async () => {
            attempts += 1;
            return attempts === 1
              ? { ok: false, message: "Codex quota unavailable" }
              : { ok: true };
          },
        },
      });
      const request = { clientMessageId: id, task: "Do work", workspacePath: "/work" };
      await expect(host.start(request)).rejects.toThrow("Codex quota unavailable");
      expect(fake.lines).toEqual([]);
      expect(fake.announcements).toEqual([]);
      expect(fake.forgotten).toEqual(known ? [] : [sessionId]);
      await host.start(request);
      expect(attempts).toBe(2);
      expect(fake.lines).toEqual([]);
      expect(fake.announcements).toHaveLength(1);
    },
  );

  test("an unavailable external submitter fails explicitly before any native launch", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe",
      external: { modelKey: async () => "codex/gpt-6.1-sol" },
    });
    await expect(
      host.start({
        clientMessageId: "missing-external-submitter",
        task: "Do work",
        workspacePath: "/work",
      }),
    ).rejects.toThrow("external runtime is unavailable");
    expect(fake.lines).toEqual([]);
    expect(fake.announcements).toEqual([]);
    expect(fake.forgotten).toEqual([petDelegationSessionId("missing-external-submitter")]);
  });

  test("an invalid model route or selector failure cannot silently launch native work", async () => {
    for (const modelKey of [
      async () => " padded ",
      async () => {
        throw new Error("settings unavailable");
      },
    ]) {
      const fake = fakeBridge();
      const host = new PetWorkDelegationHost({
        bridge: fake.bridge,
        noWorkspaceCwd: "/safe",
        external: { modelKey },
      });
      await expect(
        host.start({ clientMessageId: "invalid-route", task: "Do work", workspacePath: "/work" }),
      ).rejects.toThrow();
      expect(fake.lines).toEqual([]);
      expect(fake.announcements).toEqual([]);
      expect(fake.forgotten).toEqual([petDelegationSessionId("invalid-route")]);
    }
  });

  test("sends target-owned images with the accepted Work run and retains them as sent", async () => {
    const fixture = await stagedInput();
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/unused" });
    const launched = await host.start({
      clientMessageId: "wechat:with-image",
      task: `Diagnose the screenshot ${fixture.image.path}`,
      workspacePath: fixture.workCwd,
      inputAttachments: fixture.inputAttachments,
    });
    const params = JSON.parse(fake.lines[0]!).params;
    expect(params.attachments).toHaveLength(1);
    expect(params.attachments[0].sessionId).toBe(launched.sessionId);
    expect(params.attachments[0].absPath).toStartWith(fixture.workCwd);
    expect(params.task).toContain(params.attachments[0].absPath);
    // The bubble shows the owner's objective; brief and image plumbing are model-only.
    expect(params.displayText).toBe(`Diagnose the screenshot ${fixture.image.path}`);
    expect(fake.announcements).toEqual([expect.objectContaining({ prompt: params.displayText })]);
    const sent = await listRecentAttachments({
      cwd: fixture.workCwd,
      sessionId: launched.sessionId,
    });
    expect(sent.map((image) => image.absPath)).toEqual([params.attachments[0].absPath]);
  });

  test.each([false, true])(
    "fails a missing selected image before worker launch and preserves existing reservation=%s",
    async (known) => {
      const fixture = await stagedInput();
      await rm(fixture.image.absPath);
      const id = "wechat:missing-image";
      const sessionId = petDelegationSessionId(id);
      const fake = fakeBridge("accepted", known ? [sessionId] : []);
      const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/unused" });
      const request = {
        clientMessageId: id,
        task: `Read ${fixture.image.path}`,
        workspacePath: fixture.workCwd,
        inputAttachments: fixture.inputAttachments,
      };
      await expect(host.start(request)).rejects.toThrow();
      expect(fake.lines).toEqual([]);
      expect(fake.announcements).toEqual([]);
      expect(fake.forgotten).toEqual(known ? [] : [sessionId]);
      expect(fake.reserved).toEqual(known ? [] : [[sessionId, fixture.workCwd]]);
    },
  );

  test("stages reused Session images in its actual worktree rather than the main project", async () => {
    const fixture = await stagedInput();
    const actualCwd = join(fixture.workCwd, "actual-worktree");
    await mkdir(actualCwd);
    const fake = fakeBridge("accepted", ["existing-work"]);
    const resolved: string[] = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/unused",
      resolveSessionCwd: async (sessionId) => {
        resolved.push(sessionId);
        return actualCwd;
      },
    });
    const launched = await host.start({
      clientMessageId: "wechat:reuse-image",
      targetSessionId: "existing-work",
      task: `Read ${fixture.image.path}`,
      workspacePath: fixture.workCwd,
      inputAttachments: fixture.inputAttachments,
    });
    expect(resolved).toEqual(["existing-work"]);
    expect(launched.cwd).toBe(actualCwd);
    const params = JSON.parse(fake.lines[0]!).params;
    expect(params.cwd).toBe(actualCwd);
    expect(params.attachments[0].absPath).toStartWith(
      join(actualCwd, ".code-shell", "attachments", "existing-work"),
    );
    const context = await buildInputAttachmentContext(params.attachments, actualCwd, {
      expectedSessionId: "existing-work",
    });
    expect(context.errors).toEqual([]);
    expect(context.images).toHaveLength(1);
    expect(fake.reserved).toEqual([]);
    expect(fake.forgotten).toEqual([]);
  });

  test("refuses reused Session images when its actual directory cannot be resolved", async () => {
    const fixture = await stagedInput();
    for (const resolveSessionCwd of [undefined, async () => undefined]) {
      const fake = fakeBridge("accepted", ["existing-work"]);
      const host = new PetWorkDelegationHost({
        bridge: fake.bridge,
        noWorkspaceCwd: "/unused",
        resolveSessionCwd,
      });
      await expect(
        host.start({
          clientMessageId: "wechat:unknown-worktree",
          targetSessionId: "existing-work",
          task: `Read ${fixture.image.path}`,
          workspacePath: fixture.workCwd,
          inputAttachments: fixture.inputAttachments,
        }),
      ).rejects.toThrow("existing Work Session directory is unavailable");
      expect(fake.lines).toEqual([]);
      expect(fake.reserved).toEqual([]);
      expect(fake.forgotten).toEqual([]);
      expect(fake.announcements).toEqual([]);
    }
  });

  test("automatic Goal continuation inherits its version without submitting a new Goal", async () => {
    const fake = fakeBridge("accepted", ["existing"]);
    const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/safe" });
    await host.start({
      clientMessageId: "continue-goal",
      task: "continue",
      workspacePath: "/work",
      targetSessionId: "existing",
      goalObjective: "original",
      goalContinuation: { goalId: "goal-id", revision: 4 },
    });
    const params = JSON.parse(fake.lines[0]!).params;
    expect(params).toMatchObject({
      requireExisting: true,
      goalContinuation: { goalId: "goal-id", revision: 4 },
    });
    expect(params).not.toHaveProperty("goal");
  });
  test("turns Mimi's validated decision into one normal accepted Work Session", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });
    const request = {
      clientMessageId: "im:wechat:one",
      task: "下载视频到本地",
      workspacePath: "/work/mimi-test-videos",
    };

    const [first, duplicate] = await Promise.all([host.start(request), host.start(request)]);

    expect(first).toEqual(duplicate);
    expect(first).toEqual({
      sessionId: petDelegationSessionId("im:wechat:one"),
      cwd: "/work/mimi-test-videos",
    });
    expect(fake.lines).toHaveLength(1);
    expect(JSON.parse(fake.lines[0]!)).toMatchObject({
      method: "agent/run",
      params: {
        task: `${DESKTOP_BRIEF}\n\n下载视频到本地`,
        displayText: "下载视频到本地",
        sessionId: first.sessionId,
        cwd: "/work/mimi-test-videos",
        permissionMode: "default",
      },
    });
    expect(JSON.parse(fake.lines[0]!).params).not.toHaveProperty("goal");
    expect(fake.reserved).toEqual([[first.sessionId, "/work/mimi-test-videos"]]);
    // The brief is model-only: title and announced bubble show the objective.
    expect(fake.announcements).toEqual([
      expect.objectContaining({
        sessionId: first.sessionId,
        title: "下载视频到本地",
        prompt: "下载视频到本地",
      }),
    ]);
    expect(fake.forgotten).toEqual([]);
  });

  test("rejects unsupported Codex execution instead of substituting CodeShell", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });

    await expect(
      host.start({
        clientMessageId: "message-codex",
        task: "Run with Codex",
        workspacePath: "/work/app",
        executionBackend: "codex",
      }),
    ).rejects.toThrow("CodeShell substitution was refused");
    expect(fake.lines).toEqual([]);
  });

  test("sets a persistent Goal only when the delegation explicitly requests it", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });

    await host.start({
      clientMessageId: "pet:goal",
      task: "Resume from the durable checkpoint",
      goalObjective: "Finish and verify the migration",
      workspacePath: "/work/app",
    });

    expect(JSON.parse(fake.lines[0]!).params.goal).toBe("Finish and verify the migration");
  });

  test("fails the delegation and releases its reservation when the worker rejects it", async () => {
    const fake = fakeBridge("rejected");
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });

    await expect(
      host.start({ clientMessageId: "pet:fail", task: "do work", workspacePath: null }),
    ).rejects.toThrow("queue rejected");
    expect(fake.forgotten).toEqual([petDelegationSessionId("pet:fail")]);
    expect(fake.announcements).toEqual([]);
  });

  test("continues a selected existing Session instead of minting a new one", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });

    const launched = await host.start({
      clientMessageId: "pet:continue",
      task: "继续完成登录修复",
      workspacePath: "/work/codeshell",
      targetSessionId: "work-login",
    });

    expect(launched.sessionId).toBe("work-login");
    expect(JSON.parse(fake.lines[0]!)).toMatchObject({
      method: "agent/run",
      params: {
        sessionId: "work-login",
        cwd: "/work/codeshell",
        requireExisting: true,
      },
    });
    // Reusing a Session starts a new delegation: its first message gets the brief too.
    expect(JSON.parse(fake.lines[0]!).params).toMatchObject({
      task: `${DESKTOP_BRIEF}\n\n继续完成登录修复`,
      displayText: "继续完成登录修复",
    });
    expect(fake.announcements).toEqual([
      expect.objectContaining({
        sessionId: "work-login",
        title: "继续完成登录修复",
        prompt: "继续完成登录修复",
      }),
    ]);
  });

  test("an IM delegation's brief names the channel the owner asked from", async () => {
    const fake = fakeBridge();
    const labels: string[] = [];
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
      channelLabel: (channel) => {
        labels.push(channel);
        return channel === "wechat" ? "微信" : undefined;
      },
    });
    await host.start({
      clientMessageId: "im:wechat:brief",
      task: "Fix the login page",
      workspacePath: "/work/app",
      completionTarget: { kind: "im-gateway", channel: "wechat", target: "owner" },
    });
    await host.start({
      clientMessageId: "im:lark:brief",
      task: "Fix the login page",
      workspacePath: "/work/app",
      completionTarget: { kind: "im-gateway", channel: "lark", target: "owner" },
    });
    expect(labels).toEqual(["wechat", "lark"]);
    const tasks = fake.lines.map((line) => JSON.parse(line).params.task as string);
    expect(tasks[0]).toBe(
      `${buildDelegationBrief({ origin: "im", channelLabel: "微信" })}\n\nFix the login page`,
    );
    // Unknown labels fall back to the channel id.
    expect(tasks[1]).toContain("for the owner from lark.");
  });

  test("a host re-drive (continuation, resume, retry) does not repeat the brief", async () => {
    const fake = fakeBridge("accepted", ["work-login"]);
    const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/safe" });
    const task = "Continue the same user objective…\n\nOriginal objective:\nFix login";
    await host.start({
      clientMessageId: "pet-continuation:task:1:completed",
      task,
      originalObjective: "Fix login",
      workspacePath: "/work",
      targetSessionId: "work-login",
      completionTarget: { kind: "im-gateway", channel: "wechat", target: "owner" },
      continuationDepth: 1,
      redrive: true,
    });
    const params = JSON.parse(fake.lines[0]!).params;
    expect(params.task).toBe(task);
    expect(params).not.toHaveProperty("displayText");
    expect(fake.announcements).toEqual([expect.objectContaining({ prompt: task })]);
  });

  test("the full brief always goes first; only displayText is bounded", async () => {
    const fake = fakeBridge();
    const host = new PetWorkDelegationHost({ bridge: fake.bridge, noWorkspaceCwd: "/safe" });
    const long = "y".repeat(MAX_DELEGATION_DISPLAY_TEXT_LENGTH + 50);
    await host.start({ clientMessageId: "long:1", task: long, workspacePath: null });
    const params = JSON.parse(fake.lines[0]!).params;
    expect(params.task).toBe(`${DESKTOP_BRIEF}\n\n${long}`);
    expect(params.displayText).toBe(long.slice(0, MAX_DELEGATION_DISPLAY_TEXT_LENGTH));
  });

  test("does not forget a previously known reusable Session when its run is rejected", async () => {
    const fake = fakeBridge("rejected", ["work-login"]);
    const host = new PetWorkDelegationHost({
      bridge: fake.bridge,
      noWorkspaceCwd: "/safe/no-repo",
    });

    await expect(
      host.start({
        clientMessageId: "pet:continue-rejected",
        task: "继续完成登录修复",
        workspacePath: "/work/codeshell",
        targetSessionId: "work-login",
      }),
    ).rejects.toThrow("queue rejected");

    expect(fake.forgotten).toEqual([]);
    expect(fake.announcements).toEqual([]);
    // A previously-known Session already has its real cwd registered; the host
    // must not overwrite it with this delegation's workspace-derived cwd.
    expect(fake.reserved).toEqual([]);
  });
});
