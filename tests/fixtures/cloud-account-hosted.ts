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
  const peer: PrivateHostPeer = new PrivateHostPeer(
    nodePrivatePort(port),
    (method, raw, signal) => {
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
    const peer: PrivateHostPeer = new PrivateHostPeer(
      nodePrivatePort(port1),
      (method, raw, signal) => account.handle(method, raw, signal),
      () => account.disconnect(),
    );
    return {
      account,
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
      active.account.getCredential(login.origin, id),
      active.account.getCredential(login.origin, id),
    ]);
    assert.ok(values.every((v) => v === options.token()));
    assert.ok(!JSON.stringify(active.account.status()).includes(options.token()));
    assert.ok(!readFileSync(file).includes(options.token()));
    await active.stop();
    assert.ok(lease.signal.aborted);
    active = start();
    await active.account.connect();
    await until(() => active.account.status().state === "signed-in");
    await active.account.resume();
    assert.equal(activates, 2);
    assert.equal(await active.account.getCredential(login.origin, id), options.token());
    await assert.rejects(active.account.getCredential(login.origin, "wrong-account"), /账号/);
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
