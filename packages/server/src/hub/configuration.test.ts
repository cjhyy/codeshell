import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import {
  createHubConfiguration,
  HubConfigurationError,
  type HubConfigurationOptions,
} from "./configuration.js";

const directories: string[] = [];
const servers: Server[] = [];
const sharedSecret = "test-shared-secret-not-for-browser";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

async function fixture(options: Partial<HubConfigurationOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "hub-configuration-"));
  directories.push(cwd);
  const stateDir = join(cwd, ".code-shell");
  mkdirSync(join(stateDir, "skills", "hub.test-skill"), { recursive: true });
  writeFileSync(
    join(stateDir, "skills", "hub.test-skill", "SKILL.md"),
    "---\ndescription: Hub test skill\n---\n# Instructions\nOnly test fixture content.\n",
  );
  const localFile = join(stateDir, "settings.local.json");
  const seed = {
    defaults: { text: "primary", auxText: "secondary", image: "illustration" },
    credentials: [{ id: "shared", catalogId: "openai", apiKey: sharedSecret }],
    modelConnections: [
      {
        id: "primary",
        catalogId: "openai",
        tag: "text",
        model: "test-primary",
        credentialId: "shared",
        paramValues: { reasoning: "high" },
      },
      {
        id: "secondary",
        catalogId: "openai",
        tag: "text",
        model: "test-secondary",
        credentialId: "shared",
      },
      { id: "illustration", catalogId: "openai-images", tag: "image", model: "test-image" },
    ],
    mcpServers: {
      fixture: {
        command: "echo",
        args: ["secret-argument"],
        env: { TOKEN: "secret-env" },
        headers: { Authorization: "secret-header" },
        enabled: false,
      },
    },
    unknownFutureSetting: { untouched: true },
  };
  writeFileSync(localFile, JSON.stringify(seed), { mode: 0o600 });
  const configuration = createHubConfiguration({ cwd, ...options });
  const server = createServer((req, res) => {
    void configuration.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (endpoint = "", body?: unknown, headers?: Record<string, string>, method?: string) =>
    fetch(`${origin}/api/v1/configuration${endpoint}`, {
      method: method ?? (body === undefined ? "GET" : "PUT"),
      ...(body !== undefined
        ? {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json", ...headers },
          }
        : {}),
    });
  return { cwd, stateDir, localFile, configuration, api, origin, seed };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function cancelledResult(id: string) {
  return {
    ok: false,
    connectionId: id,
    model: "fixture",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
    code: "cancelled" as const,
    message: "已取消。",
  };
}

describe("Hub workspace configuration", () => {
  test("uses the worker's effective settings and never returns credentials or MCP secrets", async () => {
    const { api, cwd } = await fixture();
    const response = await api();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const snapshot = await response.json();
    expect(snapshot.workspace).toMatchObject({ path: cwd, settingsScope: "local" });
    expect(
      snapshot.connections.find((connection: any) => connection.id === "primary"),
    ).toMatchObject({ model: "test-primary", hasApiKey: true, needsKey: true });
    expect(snapshot.skills.find((skill: any) => skill.name === "hub.test-skill")).toMatchObject({
      source: "project",
      enabled: true,
    });
    expect(snapshot.mcpServers.find((server: any) => server.name === "fixture")).toEqual({
      name: "fixture",
      transport: "stdio",
      enabled: false,
    });
    for (const secret of [
      sharedSecret,
      "secret-argument",
      "secret-env",
      "secret-header",
      "credentialId",
    ]) {
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }
    expect(snapshot.catalog.every((entry: any) => entry.id && entry.displayName)).toBe(true);
  });

  test("strips URL credentials, query values, and fragments from every displayed endpoint", async () => {
    const { api, seed, localFile } = await fixture();
    Object.assign(seed.modelConnections[0]!, {
      baseUrl:
        "https://secret-user:secret-pass@models.example/v1?token=secret-query#secret-fragment",
    });
    writeFileSync(localFile, JSON.stringify(seed));
    const snapshot = await (await api()).json();
    expect(snapshot.connections[0].baseUrl).toBe("https://models.example/v1");
    for (const secret of ["secret-user", "secret-pass", "secret-query", "secret-fragment"])
      expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  test("saves default selection locally and can make auxiliary tasks follow the main model", async () => {
    const { api, localFile, cwd } = await fixture();
    const response = await api("/defaults", { text: "secondary", auxText: null });
    expect(response.status).toBe(200);
    expect((await response.json()).defaults).toEqual({ text: "secondary" });
    const settings = new SettingsManager(cwd, "full").get();
    expect(settings.defaults).toMatchObject({
      text: "secondary",
      auxText: "",
      image: "illustration",
    });
    expect(JSON.parse(readFileSync(localFile, "utf8")).unknownFutureSetting).toEqual({
      untouched: true,
    });
    expect(statSync(localFile).mode & 0o777).toBe(0o600);
    expect((await api("/defaults", { text: "missing" })).status).toBe(400);
    expect((await api("/defaults", { text: "illustration" })).status).toBe(400);
  });

  test("updates a model and private key atomically without changing shared credentials", async () => {
    let mutations = 0;
    const { api, localFile, cwd } = await fixture({
      withMutation: async (write) => {
        mutations++;
        return write();
      },
    });
    const response = await api("/connections", {
      id: "primary",
      catalogId: "openai",
      model: "test-updated",
      apiKey: "fresh-private-secret",
    });
    expect(response.status).toBe(200);
    expect(mutations).toBe(1);
    expect(JSON.stringify(await response.json())).not.toContain("fresh-private-secret");
    const settings = new SettingsManager(cwd, "full").get();
    const primary = settings.modelConnections.find((connection) => connection.id === "primary")!;
    const secondary = settings.modelConnections.find(
      (connection) => connection.id === "secondary",
    )!;
    expect(primary.model).toBe("test-updated");
    expect(primary.paramValues).toEqual({ reasoning: "high" });
    expect(primary.credentialId).not.toBe(secondary.credentialId);
    expect(
      settings.credentials.find((credential) => credential.id === primary.credentialId)?.apiKey,
    ).toBe("fresh-private-secret");
    expect(
      settings.credentials.find((credential) => credential.id === secondary.credentialId)?.apiKey,
    ).toBe(sharedSecret);
    expect(settings.modelConnections.some((connection) => connection.id === "illustration")).toBe(
      true,
    );
    expect(statSync(localFile).mode & 0o777).toBe(0o600);
  });

  test("adds a connection and preserves its secret when the next edit omits apiKey", async () => {
    const { api, cwd } = await fixture();
    expect(
      (
        await api("/connections", {
          id: "new-api",
          catalogId: "openai",
          model: "first",
          apiKey: "fresh-key",
        })
      ).status,
    ).toBe(200);
    expect(
      (await api("/connections", { id: "new-api", catalogId: "openai", model: "second" })).status,
    ).toBe(200);
    const settings = new SettingsManager(cwd, "full").get();
    const connection = settings.modelConnections.find((entry) => entry.id === "new-api")!;
    expect(settings.credentials.find((entry) => entry.id === connection.credentialId)?.apiKey).toBe(
      "fresh-key",
    );
    expect(connection.model).toBe("second");
  });

  test("does not silently send stored keys to a changed provider or endpoint origin", async () => {
    const { api, localFile } = await fixture();
    const before = readFileSync(localFile, "utf8");
    expect(
      (await api("/connections", { id: "primary", catalogId: "anthropic", model: "changed" }))
        .status,
    ).toBe(400);
    expect(
      (
        await api("/connections", {
          id: "primary",
          catalogId: "openai",
          model: "changed",
          baseUrl: "https://different.example/v1",
        })
      ).status,
    ).toBe(400);
    expect(readFileSync(localFile, "utf8")).toBe(before);
    expect(
      (
        await api("/connections", {
          id: "primary",
          catalogId: "openai",
          model: "changed",
          baseUrl: "https://different.example/v1",
          apiKey: "new-endpoint-key",
        })
      ).status,
    ).toBe(200);
  });

  test("skill toggles write exact names locally and override the shared project setting", async () => {
    const { api, cwd, stateDir, localFile } = await fixture();
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ capabilityOverrides: { skills: { "hub.test-skill": "on" } } }),
    );
    const disabled = await api("/skills", { name: "hub.test-skill", enabled: false });
    expect(disabled.status).toBe(200);
    expect(
      (await disabled.json()).skills.find((skill: any) => skill.name === "hub.test-skill").enabled,
    ).toBe(false);
    expect(
      computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd).disabledSkills,
    ).toContain("hub.test-skill");
    expect(JSON.parse(readFileSync(localFile, "utf8")).capabilityOverrides.skills).toEqual({
      "hub.test-skill": "off",
    });
    expect((await api("/skills", { name: "hub.test-skill", enabled: true })).status).toBe(200);
    expect(
      computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd).disabledSkills,
    ).not.toContain("hub.test-skill");
  });

  test("skill detail uses a discovered name and never accepts an arbitrary filesystem path", async () => {
    const { api, localFile } = await fixture();
    const response = await api("/skill?name=hub.test-skill");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      name: "hub.test-skill",
      content: "# Instructions\nOnly test fixture content.\n",
    });
    expect((await api(`/skill?name=${encodeURIComponent(localFile)}`)).status).toBe(404);
    expect((await api("/skill?name=../../settings.local.json")).status).toBe(404);
    expect((await api("/skills", { name: "not-installed", enabled: true })).status).toBe(404);
  });

  test("rejects protected fields, malformed bodies, and unbounded inputs without writing", async () => {
    const { api, localFile, origin } = await fixture();
    const before = readFileSync(localFile, "utf8");
    expect(
      (
        await api("/defaults", {
          text: "primary",
          permissions: { defaultMode: "bypassPermissions" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("/connections", {
          id: "primary",
          catalogId: "openai",
          model: "changed",
          apiKey: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api("/connections", {
          id: "primary",
          catalogId: "openai",
          model: "changed",
          baseUrl: "https://example.com/?secret=token",
        })
      ).status,
    ).toBe(400);
    expect(
      (await api("/defaults", { text: "primary" }, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await api("/defaults", { text: "x".repeat(70_000) })).status).toBe(413);
    expect((await api("/defaults", ["primary"])).status).toBe(400);
    expect(
      (await fetch(`${origin}/api/v1/configuration/defaults`, { method: "POST" })).status,
    ).toBe(405);
    expect(readFileSync(localFile, "utf8")).toBe(before);
  });

  test("honors the host mutation guard and rechecks revoked devices before persistence", async () => {
    const busy = await fixture({
      withMutation: async () => {
        throw new HubConfigurationError(409, "wait for active tasks");
      },
    });
    expect((await busy.api("/defaults", { text: "secondary" })).status).toBe(409);
    expect(new SettingsManager(busy.cwd, "full").get().defaults.text).toBe("primary");
    let mutationStarted = false;
    const revoked = await fixture({
      isAuthorized: async () => false,
      withMutation: async (write) => {
        mutationStarted = true;
        return write();
      },
    });
    expect((await revoked.api("/defaults", { text: "secondary" })).status).toBe(401);
    expect(mutationStarted).toBe(false);
    expect(new SettingsManager(revoked.cwd, "full").get().defaults.text).toBe("primary");
  });

  test("does not expose arbitrary failures containing secrets", async () => {
    const { api } = await fixture({
      withMutation: async () => {
        throw new Error(`failure with ${sharedSecret}`);
      },
    });
    const response = await api("/defaults", { text: "secondary" });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(JSON.stringify({ error: "configuration request failed" }));
  });

  test("deletes defaults and their replacement in one local write without dangling references", async () => {
    const f = await fixture();
    expect((await f.api("/connections", { id: "primary" }, undefined, "DELETE")).status).toBe(409);
    expect(
      (
        await f.api(
          "/connections",
          { id: "primary", replacementText: "illustration" },
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(400);
    const response = await f.api(
      "/connections",
      { id: "primary", replacementText: "secondary" },
      undefined,
      "DELETE",
    );
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.defaults).toEqual({ text: "secondary", auxText: "secondary" });
    expect(snapshot.connections.some((item: any) => item.id === "primary")).toBe(false);
    expect((await f.api("/connections", { id: "secondary" }, undefined, "DELETE")).status).toBe(
      200,
    );
    const settings = new SettingsManager(f.cwd, "full").get();
    expect(settings.defaults).toMatchObject({ text: "", auxText: "", image: "illustration" });
    expect(settings.modelConnections.map((item) => item.id)).toEqual(["illustration"]);
    expect(settings.credentials.find((item) => item.id === "shared")?.apiKey).toBe(sharedSecret);
  });

  test("removes an inherited connection only from the current workspace", async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, "settings.json"), JSON.stringify(f.seed));
    writeFileSync(f.localFile, "{}");
    expect(
      (
        await f.api(
          "/connections",
          { id: "primary", replacementText: "secondary" },
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(readFileSync(join(f.stateDir, "settings.json"), "utf8")).modelConnections,
    ).toHaveLength(3);
    expect(new SettingsManager(f.cwd, "full").get().modelConnections).toHaveLength(2);
  });

  test("keeps provider authorization failures separate from device login failures", async () => {
    let authorized = true;
    let calls = 0;
    const f = await fixture({
      isAuthorized: async () => authorized,
      probe: async (_settings, id) => {
        calls++;
        return {
          ok: false,
          connectionId: id,
          model: "fixture-model",
          latencyMs: 1,
          checkedAt: new Date().toISOString(),
          code: "unauthorized",
          message: "服务商拒绝了凭据。",
          status: 401,
        };
      },
    });
    const response = await f.api("/connections/probe", { id: "primary" }, undefined, "POST");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, code: "unauthorized", status: 401 });
    expect(calls).toBe(1);
    expect(
      (
        await f.api(
          "/connections/probe",
          { id: "primary", apiKey: "forged-key" },
          undefined,
          "POST",
        )
      ).status,
    ).toBe(400);
    authorized = false;
    expect((await f.api("/connections/probe", { id: "primary" }, undefined, "POST")).status).toBe(
      401,
    );
    expect(calls).toBe(1);
  });

  test("rechecks authorization inside the write guard before deleting", async () => {
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      withMutation: async (write) => {
        authorized = false;
        return write();
      },
    });
    expect(
      (
        await f.api(
          "/connections",
          { id: "primary", replacementText: "secondary" },
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(401);
    expect(new SettingsManager(f.cwd, "full").get().modelConnections).toHaveLength(3);
  });

  test("connection revisions stay stable across refresh and change only with their configuration", async () => {
    const f = await fixture();
    const initial = await (await f.api()).json();
    const primary = initial.connections.find((item: any) => item.id === "primary");
    expect(primary.revision).toMatch(/^[a-f0-9-]{36}$/);
    const refreshed = await (await f.api()).json();
    expect(refreshed.connections.find((item: any) => item.id === "primary").revision).toBe(
      primary.revision,
    );
    const changed = await (
      await f.api("/connections", {
        id: "primary",
        catalogId: "openai",
        model: "test-primary",
        apiKey: "rotated-private-key",
      })
    ).json();
    expect(changed.connections.find((item: any) => item.id === "primary").revision).not.toBe(
      primary.revision,
    );
    expect(changed.connections.find((item: any) => item.id === "secondary").revision).toBe(
      initial.connections.find((item: any) => item.id === "secondary").revision,
    );
    expect(JSON.stringify(changed)).not.toContain("rotated-private-key");
  });

  test("serializes probes and releases the slot when the browser cancels", async () => {
    let calls = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      probe: async (_settings, id, options) => {
        calls++;
        if (calls === 1) {
          started();
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return {
          ok: false,
          connectionId: id,
          model: "fixture",
          latencyMs: 1,
          checkedAt: new Date().toISOString(),
          code: "cancelled",
          message: "已取消。",
        };
      },
    });
    const controller = new AbortController();
    const requestId = randomUUID();
    const pending = fetch(`${f.origin}/api/v1/configuration/connections/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "primary", requestId }),
      signal: controller.signal,
    }).catch(() => undefined);
    await ready;
    expect((await f.api("/connections/probe", { id: "primary" }, undefined, "POST")).status).toBe(
      429,
    );
    controller.abort();
    await pending;
    expect(
      (await f.api("/connections/probe/cancel", { requestId }, undefined, "POST")).status,
    ).toBe(200);
    expect((await f.api("/connections/probe", { id: "primary" }, undefined, "POST")).status).toBe(
      200,
    );
    expect(calls).toBe(2);
  });

  test("a cancellation arriving before its test prevents a late upstream request", async () => {
    let called = false;
    const f = await fixture({
      probe: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    const requestId = randomUUID();
    expect(
      (await f.api("/connections/probe/cancel", { requestId }, undefined, "POST")).status,
    ).toBe(200);
    const result = await (
      await f.api("/connections/probe", { id: "primary", requestId }, undefined, "POST")
    ).json();
    expect(result.code).toBe("cancelled");
    expect(called).toBe(false);
  });

  test("deleting the last text connection also clears inherited stale defaults", async () => {
    const f = await fixture();
    writeFileSync(
      join(f.stateDir, "settings.json"),
      JSON.stringify({ defaults: { auxText: "old-unavailable-aux" } }),
    );
    writeFileSync(
      f.localFile,
      JSON.stringify({
        modelConnections: [f.seed.modelConnections[0]],
        credentials: f.seed.credentials,
        defaults: { text: "primary" },
      }),
    );
    expect((await f.api("/connections", { id: "primary" }, undefined, "DELETE")).status).toBe(200);
    expect(new SettingsManager(f.cwd, "full").get().defaults).toMatchObject({
      text: "",
      auxText: "",
    });
  });
});

describe("Hub configuration lifecycle", () => {
  test("revoking a device aborts its probe, hides the result, and releases the slot", async () => {
    const ready = deferred();
    const authorized = new Set(["laptop", "phone"]);
    let signal: AbortSignal | undefined;
    let calls = 0;
    const f = await fixture({
      isAuthorized: async (req) => authorized.has(String(req.headers["x-owner"])),
      ownerId: async (req) => String(req.headers["x-owner"]),
      probe: async (_settings, id, options) => {
        if (++calls === 1) {
          signal = options?.signal;
          ready.resolve();
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return cancelledResult(id);
      },
    });
    const pending = f.api(
      "/connections/probe",
      { id: "primary", requestId: randomUUID() },
      { "x-owner": "laptop" },
      "POST",
    );
    await ready.promise;
    authorized.delete("laptop");
    f.configuration.cancelOwner("laptop");
    expect(signal?.aborted).toBe(true);
    expect((await pending).status).toBe(401);
    expect(
      (await f.api("/connections/probe", { id: "primary" }, { "x-owner": "phone" }, "POST")).status,
    ).toBe(200);
    expect(calls).toBe(2);
  });

  test("a different device cannot cancel a probe even with its request ID", async () => {
    const ready = deferred();
    let signal: AbortSignal | undefined;
    const f = await fixture({
      ownerId: async (req) => String(req.headers["x-owner"]),
      probe: async (_settings, id, options) => {
        signal = options?.signal;
        ready.resolve();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return cancelledResult(id);
      },
    });
    const requestId = randomUUID();
    const pending = f.api(
      "/connections/probe",
      { id: "primary", requestId },
      { "x-owner": "laptop" },
      "POST",
    );
    await ready.promise;
    expect(
      (await f.api("/connections/probe/cancel", { requestId }, { "x-owner": "phone" }, "POST"))
        .status,
    ).toBe(200);
    expect(signal?.aborted).toBe(false);
    expect(
      (await f.api("/connections/probe/cancel", { requestId }, { "x-owner": "laptop" }, "POST"))
        .status,
    ).toBe(200);
    expect((await (await pending).json()).code).toBe("cancelled");
  });

  test("revocation while resolving ownership prevents a late upstream request", async () => {
    const ready = deferred();
    const resume = deferred();
    let authorized = true;
    let calls = 0;
    const f = await fixture({
      isAuthorized: async () => authorized,
      ownerId: async () => {
        ready.resolve();
        await resume.promise;
        return "laptop";
      },
      probe: async (_settings, id) => {
        calls++;
        return cancelledResult(id);
      },
    });
    const pending = f.api(
      "/connections/probe",
      { id: "primary", requestId: randomUUID() },
      undefined,
      "POST",
    );
    await ready.promise;
    authorized = false;
    f.configuration.cancelOwner("laptop");
    resume.resolve();
    expect((await pending).status).toBe(401);
    expect(calls).toBe(0);
  });

  test("closing rejects a queued write before touching settings", async () => {
    const ready = deferred();
    const resume = deferred();
    const f = await fixture({
      withMutation: async (write) => {
        ready.resolve();
        await resume.promise;
        return write();
      },
    });
    const before = readFileSync(f.localFile, "utf8");
    const pending = f.api("/defaults", { text: "secondary" });
    await ready.promise;
    f.configuration.close();
    resume.resolve();
    expect((await pending).status).toBe(503);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
    expect((await f.api()).status).toBe(503);
  });

  test("closing aborts active probes and prevents new probes", async () => {
    const ready = deferred();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const f = await fixture({
      probe: async (_settings, id, options) => {
        calls++;
        signal = options?.signal;
        ready.resolve();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return cancelledResult(id);
      },
    });
    const pending = f.api("/connections/probe", { id: "primary" }, undefined, "POST");
    await ready.promise;
    f.configuration.close();
    expect(signal?.aborted).toBe(true);
    expect((await pending).status).toBe(503);
    expect((await f.api("/connections/probe", { id: "primary" }, undefined, "POST")).status).toBe(
      503,
    );
    expect(calls).toBe(1);
  });

  test("revocation during hot reload hides the response after an already authorized commit", async () => {
    const ready = deferred();
    const resume = deferred();
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      withMutation: async (write) => {
        const result = await write();
        ready.resolve();
        await resume.promise;
        return result;
      },
    });
    const pending = f.api("/defaults", { text: "secondary" });
    await ready.promise;
    authorized = false;
    resume.resolve();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "login required" });
    expect(new SettingsManager(f.cwd, "full").get().defaults.text).toBe("secondary");
  });
});

describe("Hub connection revision conflicts", () => {
  test("a stale edit or delete cannot overwrite another device's model or key", async () => {
    const f = await fixture();
    const initial = await (await f.api()).json();
    const expectedRevision = initial.connections.find(
      (item: any) => item.id === "primary",
    ).revision;
    const body = { id: "primary", catalogId: "openai", model: "first-device", expectedRevision };
    const updated = await (
      await f.api("/connections", { ...body, apiKey: "rotated-fixture-key" })
    ).json();
    const before = readFileSync(f.localFile, "utf8");
    expect((await f.api("/connections", { ...body, model: "stale-device" })).status).toBe(409);
    expect(
      (
        await f.api(
          "/connections",
          { id: "primary", replacementText: "secondary", expectedRevision },
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(409);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
    const currentRevision = updated.connections.find((item: any) => item.id === "primary").revision;
    expect(
      (
        await f.api("/connections", {
          ...body,
          model: "reviewed-new-version",
          expectedRevision: currentRevision,
        })
      ).status,
    ).toBe(200);
    const settings = new SettingsManager(f.cwd, "full").get();
    const primary = settings.modelConnections.find((item) => item.id === "primary")!;
    expect(settings.credentials.find((item) => item.id === primary.credentialId)?.apiKey).toBe(
      "rotated-fixture-key",
    );
  });

  test("a deleted connection is not recreated by an old draft, and new-only writes cannot replace an existing ID", async () => {
    const f = await fixture();
    const initial = await (await f.api()).json();
    const expectedRevision = initial.connections.find(
      (item: any) => item.id === "primary",
    ).revision;
    expect(
      (
        await f.api(
          "/connections",
          { id: "primary", replacementText: "secondary", expectedRevision },
          undefined,
          "DELETE",
        )
      ).status,
    ).toBe(200);
    const before = readFileSync(f.localFile, "utf8");
    expect(
      (
        await f.api("/connections", {
          id: "primary",
          catalogId: "openai",
          model: "stale-draft",
          expectedRevision,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.api("/connections", {
          id: "secondary",
          catalogId: "openai",
          model: "new-name-collision",
          expectedRevision: null,
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
    expect(
      (
        await f.api("/connections", {
          id: "created",
          catalogId: "openai",
          model: "new-model",
          apiKey: "fixture-new-key",
          expectedRevision: null,
        })
      ).status,
    ).toBe(200);
  });
});
