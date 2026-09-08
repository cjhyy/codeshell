import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, PlaintextCipher } from "@cjhyy/code-shell-core";
import { createDesktopLinkConnections } from "./link-connections.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const validation = {
  providerId: "github",
  identity: {
    externalAccountId: "42",
    label: "fixture-user",
    detail: "Existing desktop return shape",
  },
  capabilityIds: ["github.list_repositories"],
  verifiedAt: "2026-09-08T00:00:00.000Z",
};
const input = {
  providerId: "github",
  methodId: "fine-grained-pat",
  label: "Fixture",
  token: "synthetic-desktop-token",
  existingId: "",
  authSource: "manual-token" as const,
};
function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "desktop-link-shared-"));
  directories.push(directory);
  return new CredentialStore(undefined, new PlaintextCipher(), directory);
}

describe("Desktop shared Link transaction adapter", () => {
  test("preserves the existing validation return and emits one shared change notification", async () => {
    const store = storeFixture();
    let notifications = 0;
    const adapter = createDesktopLinkConnections({
      store,
      validateToken: async () => validation,
      onChanged: () => {
        notifications++;
      },
    });
    try {
      expect(await adapter.connectLocal(input)).toEqual(validation);
      const saved = store.list()[0]!;
      expect(saved.id).toBe("link-github-fine-grained-pat");
      expect(saved.secret).toBe(input.token);
      expect(saved.meta?.agentExposable).toBe(false);
      expect(notifications).toBe(1);
    } finally {
      adapter.close();
    }
  });
  test("captures the expected connection before async verification and rejects a later replacement", async () => {
    const store = storeFixture();
    const first = createDesktopLinkConnections({ store, validateToken: async () => validation });
    await first.connectLocal(input);
    first.close();
    let entered = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const adapter = createDesktopLinkConnections({
      store,
      validateToken: async () => {
        entered = true;
        await gate;
        return validation;
      },
    });
    try {
      const pending = adapter.connectLocal({
        ...input,
        existingId: "link-github-fine-grained-pat",
        token: "replacement",
      });
      expect(entered).toBe(true);
      const current = store.list()[0]!;
      store.save("user", { ...current, secret: "changed-by-another-host" });
      finish();
      await expect(pending).rejects.toMatchObject({ code: "conflict" });
      expect(store.list()[0]?.secret).toBe("changed-by-another-host");
    } finally {
      adapter.close();
    }
  });
  test("retains Desktop interactive CLI login while storing only a private binding marker", async () => {
    const store = storeFixture();
    let interactive: boolean | undefined;
    const adapter = createDesktopLinkConnections({
      store,
      connectCli: async (_provider, options) => {
        interactive = options.loginIfNeeded;
        return validation;
      },
    });
    try {
      expect(
        await adapter.connectCli({
          ...input,
          providerId: "github",
          label: "",
          loginIfNeeded: true,
        }),
      ).toEqual(validation);
      expect(interactive).toBe(true);
      const saved = store.list()[0]!;
      expect(saved.label).toBe("GitHub · fixture-user");
      expect(saved.secret).toStartWith("cli-binding:");
      expect(saved.meta?.linkExecutionBackend).toBe("cli");
    } finally {
      adapter.close();
    }
  });
  test("retains OAuth refresh and expiry material behind the same secret store", async () => {
    const store = storeFixture();
    const adapter = createDesktopLinkConnections({ store, validateToken: async () => validation });
    try {
      await adapter.connectLocal({
        ...input,
        authSource: "browser-oauth",
        browserOAuthToken: {
          providerId: "github",
          accessToken: input.token,
          refreshToken: "synthetic-refresh",
          expiresIn: 7200,
          tokenType: "Bearer",
          clientId: "public-fixture",
          tokenEndpoint: "https://github.com/login/oauth/access_token",
        },
      });
      const secret = JSON.parse(store.list()[0]!.secret!);
      expect(secret.refreshToken).toBe("synthetic-refresh");
      expect(Date.parse(secret.expiresAt)).toBeGreaterThan(Date.now());
      expect(store.list()[0]?.meta?.linkAuthSource).toBe("browser-oauth");
    } finally {
      adapter.close();
    }
  });
  test("a supplied foreign connection id fails before contacting the provider", async () => {
    const store = storeFixture();
    let calls = 0;
    const adapter = createDesktopLinkConnections({
      store,
      validateToken: async () => {
        calls++;
        return validation;
      },
    });
    try {
      await expect(adapter.connectLocal({ ...input, existingId: "foreign" })).rejects.toThrow(
        "does not belong",
      );
      expect(calls).toBe(0);
    } finally {
      adapter.close();
    }
  });
});
