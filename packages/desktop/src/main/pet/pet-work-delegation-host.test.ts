import { describe, expect, test } from "bun:test";
import { PetWorkDelegationHost, petDelegationSessionId } from "./pet-work-delegation-host";

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
        task: "下载视频到本地",
        sessionId: first.sessionId,
        cwd: "/work/mimi-test-videos",
        permissionMode: "default",
      },
    });
    expect(fake.reserved).toEqual([[first.sessionId, "/work/mimi-test-videos"]]);
    expect(fake.announcements).toEqual([
      expect.objectContaining({ sessionId: first.sessionId, prompt: "下载视频到本地" }),
    ]);
    expect(fake.forgotten).toEqual([]);
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
    expect(fake.announcements).toEqual([
      expect.objectContaining({ sessionId: "work-login", prompt: "继续完成登录修复" }),
    ]);
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
