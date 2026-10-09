import { expect, test } from "bun:test";
import type { LinkAuthorization, LinkConnectionInput } from "@cjhyy/code-shell-link";
import {
  LinkAuthorizationController,
  safeLinkAuthorizationUrl,
  selectPreferredLinkAuthMode,
  type LinkAuthorizationTransport,
} from "./link-authorization.js";

const input: LinkConnectionInput = {
  providerId: "fixture",
  methodId: "local-token",
  label: "Fixture",
  expectedRevision: null,
};
function pending(kind: "processing" | "credential-input" = "processing"): LinkAuthorization {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    id: "attempt-1",
    providerId: "fixture",
    methodId: "local-token",
    state: "pending",
    expiresAt,
    step: {
      id: "step-1",
      expiresAt,
      ...(kind === "credential-input"
        ? {
            kind,
            purpose: "credential",
            fields: [{ id: "token", label: "Token", secret: true, required: true }],
          }
        : { kind }),
    },
  };
}
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(patch: Partial<LinkAuthorizationTransport> = {}) {
  let cancels = 0;
  let reads = 0;
  const controller = new LinkAuthorizationController(
    {
      begin: async () => pending(),
      status: async () => {
        reads++;
        return pending();
      },
      respond: async () => pending(),
      cancel: async () => {
        cancels++;
      },
      ...patch,
    },
    { pollIntervalMs: 1, retryIntervalMs: 1 },
  );
  return {
    controller,
    get cancels() {
      return cancels;
    },
    get reads() {
      return reads;
    },
  };
}

test("late status cannot reopen a cancelled attempt", async () => {
  let resolve!: (value: LinkAuthorization) => void;
  const read = new Promise<LinkAuthorization>((done) => {
    resolve = done;
  });
  const view = fixture({ status: () => read });
  await view.controller.begin(input, "mode");
  await pause();
  await view.controller.cancel();
  resolve(pending());
  await pause();
  expect(view.controller.getSnapshot().authorization?.state).toBe("cancelled");
  expect(view.cancels).toBe(1);
  view.controller.dispose();
});

test("closing during begin cancels the later attempt without publishing it", async () => {
  let resolve!: (value: LinkAuthorization) => void;
  const begin = new Promise<LinkAuthorization>((done) => {
    resolve = done;
  });
  const view = fixture({ begin: () => begin });
  const starting = view.controller.begin(input, "mode");
  view.controller.dispose();
  resolve(pending());
  await starting;
  expect(view.cancels).toBe(1);
  expect(view.controller.getSnapshot().authorization).toBeUndefined();
});

test("credential input waits for explicit submit and uncertain writes are never replayed", async () => {
  let writes = 0;
  const view = fixture({
    begin: async () => pending("credential-input"),
    respond: async () => {
      writes++;
      throw new Error("network interrupted");
    },
  });
  await view.controller.begin(input, "mode");
  await pause();
  expect(view.reads).toBe(0);
  await view.controller.respond({
    stepId: "stale-step",
    operation: "submit",
    input: { token: "secret" },
  });
  expect(writes).toBe(0);
  await view.controller.respond({
    stepId: "step-1",
    operation: "submit",
    input: { token: "secret" },
  });
  await pause();
  expect(writes).toBe(1);
  expect(view.reads).toBeGreaterThan(0);
  view.controller.dispose();
});

test("connected without a persisted connection cannot be treated as success", async () => {
  const view = fixture({
    begin: async () => ({ ...pending(), state: "connected", step: undefined }),
  });
  expect(await view.controller.begin(input, "mode")).toBeUndefined();
  expect(view.controller.getSnapshot().authorization).toBeUndefined();
  expect(view.controller.getSnapshot().error?.message).toContain("保存");
  view.controller.dispose();
});

test("unknown pending step and a response for another provider fail closed and cancel", async () => {
  for (const value of [
    { ...pending(), step: { ...pending().step, kind: "arbitrary-html" } },
    { ...pending(), providerId: "other-provider" },
  ]) {
    const view = fixture({ begin: async () => value as LinkAuthorization });
    expect(await view.controller.begin(input, "mode")).toBeUndefined();
    expect(view.controller.getSnapshot().error).toBeDefined();
    expect(view.cancels).toBe(1);
    view.controller.dispose();
  }
});

test("expired steps clear interactive data and cancel the Host attempt", async () => {
  const value = pending();
  value.step!.expiresAt = new Date(Date.now() - 1).toISOString();
  const view = fixture({ begin: async () => value });
  await view.controller.begin(input, "mode");
  expect(view.controller.getSnapshot().authorization).toMatchObject({
    state: "failed",
    errorCode: "authorization_expired",
  });
  expect(view.controller.getSnapshot().authorization?.step).toBeUndefined();
  expect(view.cancels).toBe(1);
  view.controller.dispose();
});

test("only available Host modes are selected and external navigation rejects embedded credentials", () => {
  expect(
    selectPreferredLinkAuthMode({
      authModes: [
        {
          id: "future",
          methodId: "server",
          kind: "redirect",
          label: "Future",
          preferred: true,
          available: false,
        },
        {
          id: "token",
          methodId: "local",
          kind: "credential-input",
          label: "Token",
          available: true,
        },
        {
          id: "browser",
          methodId: "server",
          kind: "redirect",
          label: "Browser",
          preferred: true,
          available: true,
        },
      ],
    })?.id,
  ).toBe("browser");
  expect(safeLinkAuthorizationUrl("javascript:alert(1)")).toBeUndefined();
  expect(safeLinkAuthorizationUrl("https://user:secret@example.com")).toBeUndefined();
  expect(safeLinkAuthorizationUrl("http://example.com")).toBeUndefined();
  expect(safeLinkAuthorizationUrl("http://localhost.evil.example/link/authorize")).toBeUndefined();
  expect(safeLinkAuthorizationUrl("http://127.0.0.1:4310/link/authorize")).toBe(
    "http://127.0.0.1:4310/link/authorize",
  );
  expect(safeLinkAuthorizationUrl("http://[::1]:4310/link/authorize")).toBe(
    "http://[::1]:4310/link/authorize",
  );
  expect(safeLinkAuthorizationUrl("https://github.com/login/device")).toBe(
    "https://github.com/login/device",
  );
});
