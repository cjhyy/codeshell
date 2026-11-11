import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type StreamEvent } from "@cjhyy/code-shell-core";
import {
  createSessionToolHost,
  deriveExternalToolExposure,
} from "@cjhyy/code-shell-core/extension";
import type { ExternalRuntimeSessionOptions } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { ExternalRuntimeService } from "../external-runtime-service.js";
import { createPetExternalRuntime } from "./pet-external-runtime.js";
import { readExternalRuntimeBinding } from "../external-runtime-state.js";

let root: string, cwd: string, previousHome: string | undefined;
let service: ExternalRuntimeService;
let adapter: ReturnType<typeof createPetExternalRuntime>;
let flags: { external_agent_runtime: boolean; external_host_tools: boolean };
let starts: ExternalRuntimeSessionOptions[];
let inputs: string[];
let body: (host: ReturnType<typeof createSessionToolHost>) => Promise<void>;
let memoryCalls: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codeshell-pet-external-"));
  previousHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = join(root, "home");
  cwd = join(root, "workspace");
  mkdirSync(cwd);
  flags = { external_agent_runtime: true, external_host_tools: true };
  starts = [];
  inputs = [];
  memoryCalls = 0;
  body = async () => {};
  service = new ExternalRuntimeService({
    featureFlags: () => flags,
    registerSession: () => {},
    releaseSession: () => {},
    resolveProjectBinding: () => undefined,
    emit: () => {},
    projectTrust: () => "trusted",
    prepareCodexLaunch: async () => ({ command: "/fixture/codex", env: {} }),
    memory: {
      schedule: () => {
        memoryCalls++;
      },
      cancel: () => {},
      dispose: () => {},
    } as never,
    startSession: async (options) => {
      starts.push(options);
      const { hooks: _runtimeHooks, ...hostOptions } = options;
      const host = createSessionToolHost({
        ...hostOptions,
        getExposure: () =>
          deriveExternalToolExposure(options.registry, { mimiHost: options.mimiHost }),
      });
      return {
        kind: options.kind,
        businessSessionId: options.businessSessionId,
        runtimeSessionId: `fixture-${starts.length}`,
        listTools: () => host.listTools(),
        send: async (input, emit) => {
          inputs.push(input.text);
          await body(host);
          emit?.({ type: "text_delta", text: "external reply" } as StreamEvent);
          emit?.({ type: "turn_complete", reason: "completed" } as StreamEvent);
          return { accepted: true as const, done: Promise.resolve() };
        },
        interrupt: async () => {},
        close: () => host.dispose(),
      };
    },
  });
  adapter = createPetExternalRuntime({ service: () => service, cwd });
});
afterEach(async () => {
  await service.stopAll();
  if (previousHome === undefined) delete process.env.CODE_SHELL_HOME;
  else process.env.CODE_SHELL_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

function params(clientMessageId = "im:wechat:first", model = "codex/gpt-6.1-sol") {
  return {
    sessionId: "pet-external",
    task: "微信中回复我",
    clientMessageId,
    model,
    kind: "pet",
    behaviorMode: "pet",
    permissionMode: "default",
    profileParams: {
      runtimeContext: '{"currentMessageSource":{"kind":"im-gateway","channel":"wechat"}}',
      workspaces: [{ id: "workspace-a", name: "Workspace" }],
      reusableSessions: [],
      hostActions: ["gatewayReply"],
      gatewayReply: {
        button: "link",
        attachments: [],
        maxTextLength: 8000,
        maxAttachments: 4,
        maxAttachmentBytes: 10485760,
      },
    },
  };
}

describe("actual external Mimi runtime composition", () => {
  test.each(["codex/gpt-6.1-sol", "claude-code/sonnet"])(
    "%s exposes only reviewed manager tools and retains Pet results",
    async (model) => {
      body = async (host) => {
        const names = host.listTools().map((tool) => tool.name);
        expect(names).toContain("GatewayReply");
        expect(names).toContain("DelegateWork");
        expect(names).not.toContain("Bash");
        expect(names).not.toContain("Read");
        const reply = await host.execute({
          id: "reply",
          name: "GatewayReply",
          input: { text: "只走外部额度" },
        });
        expect(reply.isError).not.toBe(true);
      };
      const result = await adapter.run(params(undefined, model));
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.result.extensions?.pet).toMatchObject({
        hostActions: [{ kind: "gatewayReply", payload: { text: "只走外部额度" } }],
      });
      expect(starts[0]!.sandbox).toBe("read-only");
      expect(starts[0]!.disableNativeTools).toBe(true);
      expect(starts[0]!.visibility.behaviorProfile).toBe("pet");
      expect(starts[0]!.mimiHost).toBe(true);
      expect(memoryCalls).toBe(0);
      expect(new SessionManager().readSessionState("pet-external")?.kind).toBe("pet");
    },
  );

  test("each turn captures its own services; restarts replay durable results without another provider call", async () => {
    let revision = 0;
    body = async (host) => {
      revision++;
      await host.execute({
        id: `reply-${revision}`,
        name: "GatewayReply",
        input: { text: `reply-${revision}` },
      });
    };
    await adapter.run(params());
    const next = await adapter.run(params("im:wechat:second"));
    expect(starts.length).toBe(1);
    expect(next.ok && next.result.extensions?.pet).toMatchObject({
      hostActions: [{ payload: { text: "reply-2" } }],
    });
    const restarted = createPetExternalRuntime({ service: () => service, cwd });
    const replay = await restarted.run(params("im:wechat:second"));
    expect(replay).toEqual(next);
    expect(inputs.length).toBe(2);
  });

  test.each(["external_agent_runtime", "external_host_tools"] as const)(
    "%s disabled refuses without any inference",
    async (flag) => {
      flags[flag] = false;
      await expect(adapter.run(params())).rejects.toThrow();
      expect(starts).toHaveLength(0);
      expect(inputs).toHaveLength(0);
    },
  );

  test("/clear drops the resume binding and does not revive old history in the next fresh thread", async () => {
    await adapter.run(params());
    expect(readExternalRuntimeBinding("pet-external")).toBeDefined();
    await adapter.resetContext("pet-external");
    expect(readExternalRuntimeBinding("pet-external")).toBeUndefined();
    await adapter.run({ ...params("im:wechat:after-clear"), task: "fresh topic" });
    expect(starts[1]!.resumeRuntimeSessionId).toBeUndefined();
    expect(starts[1]!.initialContext).toBeUndefined();
  });

  test("an acknowledged stop during preparation prevents a subsequent model request", async () => {
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter = createPetExternalRuntime({
      service: () => service,
      cwd,
      history: async () => {
        entered();
        await blocked;
        return [];
      },
    });
    const pending = adapter.run(params());
    await waiting;
    await adapter.stop("pet-external");
    release();
    await expect(pending).rejects.toThrow("已停止");
    expect(starts).toHaveLength(0);
    expect(inputs).toHaveLength(0);
  });

  test("receipt turns with an empty tool allowlist cannot borrow manager tools", async () => {
    body = async (host) => {
      expect(host.listTools()).toEqual([]);
    };
    const result = await adapter.run({ ...params(), toolAllowlist: [] });
    expect(result.ok).toBe(true);
    expect(starts[0]!.exposure?.toolNames.size).toBe(0);
  });

  test("switching through a native turn restarts the external thread with the intervening context", async () => {
    await adapter.run(params());
    const transcript = new SessionManager().resume("pet-external").transcript;
    transcript.appendMessage("user", "a native follow-up", { clientMessageId: "native-input" });
    transcript.appendMessage("assistant", "native answer to remember");
    await adapter.run(params("external-again"));
    expect(starts).toHaveLength(2);
    expect(starts[1]!.resumeRuntimeSessionId).toBeUndefined();
    expect(starts[1]!.initialContext).toContain("native answer to remember");
  });

  test("a reused upstream identity with different content is rejected instead of replayed", async () => {
    await adapter.run(params());
    await expect(adapter.run({ ...params(), task: "changed input" })).rejects.toThrow(
      "内容发生变化",
    );
    expect(inputs).toHaveLength(1);
  });

  test("a failed provider result is durable and a retry does not invoke a second inference", async () => {
    body = async () => {
      throw new Error("Codex quota unavailable");
    };
    const failed = await adapter.run(params());
    expect(failed).toEqual({ ok: false, message: "Codex quota unavailable" });
    expect(await adapter.run(params())).toEqual(failed);
    expect(inputs).toHaveLength(1);
  });
});
