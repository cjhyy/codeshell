import { deviceTransports, nativeDevices } from "./account-device-hosted.ts";
import { HostedAccountDevices } from "../../packages/desktop/src/host/remote/account-devices.js";
import { HostedCloudProjects } from "../../packages/desktop/src/host/remote/cloud-projects.js";
import { NativeCloudProjects } from "../../packages/desktop/src/main/desktop-host/cloud-projects-client.js";
import { createCloudManagementTransport } from "../../packages/desktop/src/main/cloud-management-http.js";
import { managedCloudPartition } from "@cjhyy/code-shell-server/account";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel, Worker, workerData } from "node:worker_threads";
import { CloudAccountStore, createCloudAccountTransport } from "@cjhyy/code-shell-server/account";
import { fixtureCipher } from "../../packages/server/src/account/__fixtures__/native-account-fixture-store.js";
import { HostedCloudAccount } from "../../packages/desktop/src/host/remote/cloud-account.js";
import { nodePrivatePort, PrivateHostPeer } from "../../packages/desktop/src/host/native-peer.js";
import { NativeCloudAccount } from "../../packages/desktop/src/main/desktop-host/cloud-client.js";

if (workerData?.kind === "account-fixture") {
  const { origin, ca, file, port } = workerData;
  const request = createCloudAccountTransport(Buffer.from(ca));
  const account = new HostedCloudAccount(
    () => peer,
    file,
    (input) => {
      assert.equal(input.origin, origin, "only the fixture HTTPS server can be contacted");
      return request(input);
    },
  );
  const devices = new HostedAccountDevices(
    () => peer,
    account.manager,
    async () => ({
      sourceHostId: "fixture-source",
      sourceDeviceCredential: "fixture-source-proof",
    }),
    deviceTransports(origin, Buffer.from(ca)),
  );
  const projectTransport = createCloudManagementTransport(Buffer.from(ca));
  const projects = new HostedCloudProjects(
    () => peer,
    account,
    (input) => {
      assert.equal(input.origin, origin);
      return projectTransport(input);
    },
  );
  const peer: PrivateHostPeer = new PrivateHostPeer(
    nodePrivatePort(port),
    (method, raw, signal) => {
      if (method.startsWith("devices/")) return devices.run(method, raw, signal);
      if (method.startsWith("projects/")) return projects.run(method, raw, signal);
      assert.equal(method, "cloud/account");
      return account.run(raw, signal);
    },
    () => account.close(),
  );
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "timed out waiting for account transition");
}

export async function exerciseHostedAccount(options: {
  origin: string;
  ca: Buffer;
  projectId: string;
  root: string;
  token: () => string;
}) {
  const file = join(options.root, "desktop-account.enc"),
    cipher = fixtureCipher();
  let entering: (() => void) | undefined, release: (() => void) | undefined;
  let opens = 0,
    activates = 0;
  const custody = CloudAccountStore.custody(file, {
    available: async () => true,
    encrypt: async (v) => {
      if (entering && v.startsWith("{")) {
        entering();
        entering = undefined;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return cipher.encrypt(v);
    },
    decrypt: async (v) => cipher.decrypt(v),
  });
  const partitions = new Set<string>();
  let entitled = true;
  const start = () => {
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: "account-fixture",
        port: port2,
        origin: options.origin,
        ca: options.ca,
        file,
      },
      transferList: [port2],
    });
    const account = new NativeCloudAccount(() => peer, {
      custody,
      changed: () => {},
      openExternal: async (url) => {
        assert.equal(new URL(url).origin, options.origin);
        assert.equal(new URL(url).pathname, "/desktop-login");
        opens++;
      },
      activateRelay: async (_identity, allowed) => {
        assert.ok(allowed());
        activates++;
      },
    });
    const { devices, exercise } = nativeDevices(() => peer, account, options.origin);
    const projects = new NativeCloudProjects(() => peer, {
      account,
      requireFeature() {
        if (!entitled) throw Error("not subscribed");
      },
      onFeatureChange: () => () => {},
      windows: {
        open: async ({ grant, projectId, authorized }) => {
          assert.ok(authorized());
          assert.equal(projectId, options.projectId);
          assert.notEqual(grant.token, options.token());
          partitions.add(managedCloudPartition(grant));
          return { address: options.origin + "/?project=" + projectId };
        },
        close: async (key) => {
          partitions.delete(key);
        },
      },
    });
    const peer: PrivateHostPeer = new PrivateHostPeer(
      nodePrivatePort(port1),
      (method, raw, signal) =>
        method.startsWith("devices/")
          ? devices.handle(method, raw, signal)
          : method.startsWith("projects/")
            ? projects.handle(method, raw, signal)
            : account.handle(method, raw, signal),
      () => {
        account.disconnect();
        void projects.disconnect();
        devices.disconnect();
      },
      (method, raw) => {
        assert.equal(method, "devices/event");
        devices.notice(raw);
      },
    );
    return {
      account,
      projects,
      exercise,
      stop: async () => {
        peer.close();
        await worker.terminate();
      },
    };
  };
  let active = start();
  const login = { origin: options.origin, username: "alice", password: "native fixture password" };
  try {
    await active.account.connect();
    const status = await active.account.signIn("login", login);
    assert.equal(status.state, "signed-in");
    assert.ok(status.account);
    assert.equal(activates, 1);
    const id = status.account.id;
    const lease = active.account.captureRootAccount(login.origin, id, () => true);
    const values = await Promise.all([
      active.account.overview({ origin: login.origin, accountId: id }),
      active.account.overview({ origin: login.origin, accountId: id }),
    ]);
    assert.ok(values.every((v) => v.account.id === id));
    assert.ok(!JSON.stringify(active.account.status()).includes(options.token()));
    assert.ok(!readFileSync(file).includes(options.token()));
    await active.exercise(options.projectId);
    const projectRequest = {
      action: "open",
      accountOrigin: login.origin,
      accountId: id,
      cloudOrigin: login.origin,
      projectId: options.projectId,
    };
    entitled = false;
    await assert.rejects(
      active.projects.manage(projectRequest, () => true),
      /not subscribed/,
    );
    entitled = true;
    const projectView = await active.projects.manage(projectRequest, () => true);
    assert.equal(projectView.action, "open");
    assert.equal(partitions.size, 1);
    await active.stop();
    assert.ok(lease.signal.aborted);
    assert.equal(partitions.size, 0, "Host crash destroys its Native cloud windows");
    active = start();
    await active.account.connect();
    await until(() => active.account.status().state === "signed-in");
    await active.account.resume();
    assert.equal(activates, 2);
    await active.projects.manage(projectRequest, () => true);
    assert.equal(partitions.size, 1);
    const loggedOut = await active.projects.manage(
      { accountOrigin: login.origin, accountId: id, cloudOrigin: login.origin, action: "logout" },
      () => true,
    );
    assert.deepEqual(loggedOut, { action: "logout", revoked: true });
    assert.equal(partitions.size, 0);
    assert.equal(
      (await active.account.overview({ origin: login.origin, accountId: id })).account.id,
      id,
    );
    await assert.rejects(
      active.account.overview({ origin: login.origin, accountId: "wrong-account" }),
      /账号/,
    );
    assert.equal((await active.account.logout()).revocation, "confirmed");
    assert.ok(!existsSync(file));

    const browser = await active.account.signInWithBrowser({ origin: login.origin });
    assert.equal(browser.state, "signed-in");
    assert.equal(opens, 1);
    assert.equal(activates, 3);
    await active.account.logout();

    const document = new AbortController();
    const entered = new Promise<void>((resolve) => {
      entering = resolve;
    });
    const stale = active.account.withDocument(document.signal, () =>
      active.account.signIn("login", login),
    );
    await entered;
    document.abort();
    release!();
    await assert.rejects(stale);
    assert.ok(!existsSync(file), "late OS approval cannot restore revoked document authority");
    assert.equal(activates, 3);
    assert.equal(opens, 1);
  } finally {
    release?.();
    await active.stop();
  }
}
