import { expect, test } from "bun:test";
import { createInProcessTransport } from "../protocol/transport.js";
import type { RpcMessage } from "../protocol/types.js";
import { createIpcCredentialAccess } from "./access.js";

function fixture(kind: "remote" | "local") {
  const [main, worker] = createInProcessTransport();
  const access = createIpcCredentialAccess(worker);
  const messages: RpcMessage[] = [];
  main.onMessage((message) => messages.push(message));
  const input = {
    id: "fixture-link",
    scope: "full" as const,
    action: "get_issue",
    params: { owner: "fixture", repo: "fixture", issue_number: 1 },
    ...(kind === "remote"
      ? { grantId: "fixture-grant" }
      : { accountId: "42", verifiedAt: "2026-10-15T00:00:00Z" }),
  };
  const execute = (options: { signal?: AbortSignal; assertAuthorized?: () => void }) =>
    kind === "remote"
      ? access.executeRemoteLinkAction!(
          input as Parameters<NonNullable<typeof access.executeRemoteLinkAction>>[0],
          options,
        )
      : access.executeLocalOAuthLinkAction!(
          input as Parameters<NonNullable<typeof access.executeLocalOAuthLinkAction>>[0],
          options,
        );
  const respond = (result: unknown) => {
    const message = messages.find((item) => "id" in item && "method" in item)!;
    main.send({ jsonrpc: "2.0", id: message.id!, result });
  };
  return { input, messages, execute, respond };
}

test.each(["remote", "local"] as const)(
  "%s IPC checks custody before sending and returning, without wiring functions",
  async (kind) => {
    const f = fixture(kind);
    let checks = 0;
    const pending = f.execute({ assertAuthorized: () => checks++ });
    expect(f.messages).toHaveLength(1);
    const request = f.messages[0]!;
    expect("params" in request && request.params).toEqual(f.input);
    expect(JSON.stringify(request)).not.toContain("assertAuthorized");
    expect(JSON.stringify(request)).not.toContain("signal");
    f.respond({ fixture: "result" });
    expect(await pending).toEqual({ fixture: "result" });
    expect(checks).toBe(2);
  },
);

test.each(["remote", "local"] as const)(
  "%s IPC refuses a revoked run before any request",
  async (kind) => {
    const f = fixture(kind);
    await expect(
      f.execute({
        assertAuthorized: () => {
          throw new Error("run revoked");
        },
      }),
    ).rejects.toThrow("run revoked");
    expect(f.messages).toEqual([]);
  },
);

test.each(["remote", "local"] as const)(
  "%s IPC discards results after custody was revoked",
  async (kind) => {
    const f = fixture(kind);
    let current = true;
    const pending = f.execute({
      assertAuthorized: () => {
        if (!current) throw new Error("run revoked");
      },
    });
    current = false;
    f.respond({ protected: "result" });
    await expect(pending).rejects.toThrow("run revoked");
  },
);

test.each(["remote", "local"] as const)(
  "%s IPC cancellation still rejects a late response locally",
  async (kind) => {
    const f = fixture(kind);
    const controller = new AbortController();
    const pending = f.execute({ signal: controller.signal, assertAuthorized: () => {} });
    controller.abort();
    f.respond({ protected: "result" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(JSON.stringify(f.messages)).not.toContain("assertAuthorized");
  },
);
