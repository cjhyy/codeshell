import { fork, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { setDefaultCredentialCipher } from "@cjhyy/code-shell-core";
import { bindImGateway } from "../../src/host/im/gateway.js";
import { NativeImGateway } from "../../src/main/desktop-host/im-gateway-client.js";
import type { PrivatePort } from "../../src/host/native-peer.js";

const root = process.argv[2]!;
const configPath = join(root, "config.json"),
  descriptorPath = join(root, ".code-shell", "im-gateway", "desktop-control.json"),
  deliveries = join(root, "delivered.jsonl");
function port(channel: NodeJS.Process | ChildProcess): PrivatePort {
  return {
    send: (value) => {
      channel.send!(value as object);
    },
    close: () => {
      if (channel.connected) channel.disconnect();
    },
    listen: (recv, closed) => {
      channel.on("message", recv);
      channel.once("disconnect", closed);
    },
  };
}
if (process.argv[3] === "utility") {
  const service = bindImGateway(port(process), {
    descriptorPath,
    gateway: {
      configPath,
      createChannelAdapter: ({ channel }) => ({
        channel,
        run: async (_handler, signal) => {
          if (!signal.aborted)
            await new Promise<void>((r) =>
              signal.addEventListener("abort", () => r(), { once: true }),
            );
        },
        send: async (target, msg) => {
          appendFileSync(
            deliveries,
            JSON.stringify({ target, text: msg.text, pid: process.pid }) + "\n",
          );
        },
      }),
    },
  });
  process.on("disconnect", () => void service.close().finally(() => process.exit()));
} else {
  const key = randomBytes(32);
  let entered: (() => void) | undefined, release: (() => void) | undefined;
  let foreignReads = 0;
  const foreign = "enc:other:opaque";
  const cipher = {
    encrypt(value: string) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const out = Buffer.concat([c.update(value), c.final()]);
      return "enc:fixture:" + Buffer.concat([iv, c.getAuthTag(), out]).toString("base64");
    },
    decrypt(value: string) {
      if (value === foreign) foreignReads++;
      const bytes = Buffer.from(value.slice("enc:fixture:".length), "base64");
      const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString();
    },
  };
  setDefaultCredentialCipher({
    ...cipher,
    canDecrypt: () => true,
    asynchronous: {
      encrypt: async (text) => {
        if (entered) {
          entered();
          entered = undefined;
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return cipher.encrypt(text);
      },
      decrypt: async (text) => cipher.decrypt(text),
      canDecrypt: async () => true,
    },
  });
  const native = new NativeImGateway(async () => {});
  const start = () => {
    const child = fork(fileURLToPath(import.meta.url), [root, "utility"], {
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    native.bind(port(child));
    return child;
  };
  let child = start(),
    ready = 0;
  const status = {
    running: false,
    tunnelRunning: false,
    tunnelConnected: false,
    passcodeSet: false,
    onlineDeviceCount: 0,
  };
  async function until(test: () => boolean) {
    for (let i = 0; i < 500; i++) {
      if (test()) return;
      await wait(10);
    }
    throw Error("IM fixture timeout");
  }
  const stop = async (hard = false) => {
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    if (hard) child.kill("SIGKILL");
    else native.disconnect();
    await exited;
  };
  try {
    await native.boot({
      open: async () => {
        throw Error("no public tunnel in fixture");
      },
      close: async () => {},
      status: () => status,
      pairingUrl: () => {
        throw Error("no pairing");
      },
      event: () => {},
      ready: () => {
        ready++;
      },
      outcome: () => {},
    });
    const control = JSON.parse(readFileSync(descriptorPath, "utf8"));
    assert.equal(control.pid, child.pid);
    assert.notEqual(control.pid, process.pid);
    assert.equal((await fetch(control.baseUrl + "/v1/status")).status, 401);
    const response = await fetch(control.baseUrl + "/v1/status", {
      headers: { Authorization: "Bearer " + control.token },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), status);
    await native.ensureConfig();
    const file = join(root, ".code-shell", "credentials.json");
    const other = { id: "other-account", type: "token", label: "opaque fixture", secret: foreign };
    writeFileSync(file, JSON.stringify({ version: 1, credentials: [other] }), { mode: 0o600 });
    const input = {
      enabled: true,
      clientId: "fixture",
      clientSecret: randomBytes(32).toString("hex"),
      allowedConversationIds: ["fixture-room"],
      allowedUserIds: [],
    };
    const doc = new AbortController();
    const began = new Promise<void>((r) => {
      entered = r;
    });
    const forgotten = native
      .withDocument(doc.signal, () => native.saveDingTalkSetup(input))
      .then(
        () => false,
        () => true,
      );
    await began;
    doc.abort();
    release!();
    assert.ok(await forgotten);
    assert.equal((await native.getDingTalkSetup()).hasClientSecret, false);
    const encrypting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const concurrent = native.withDocument(new AbortController().signal, () =>
      native.saveDingTalkSetup(input),
    );
    await encrypting;
    const edited = JSON.parse(readFileSync(configPath, "utf8"));
    edited.dingtalk.clientId = "different-setup";
    writeFileSync(configPath, JSON.stringify(edited), { mode: 0o600 });
    release!();
    await assert.rejects(concurrent, /配置已更改/);
    assert.equal((await native.getDingTalkSetup()).hasClientSecret, false);
    assert.equal(
      (
        await native.withDocument(new AbortController().signal, () =>
          native.saveDingTalkSetup(input),
        )
      ).secretStorage,
      "secure",
    );
    assert.ok(!readFileSync(configPath, "utf8").includes(input.clientSecret));
    assert.equal(await native.isOwnerConversation("dingtalk", "fixture-room"), true);
    assert.ok(
      readFileSync(join(root, ".code-shell", "credentials.json"), "utf8").includes("enc:fixture:"),
    );
    await native.start();
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.dingtalk.allowedConversationIds = ["replacement"];
    writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
    assert.equal(await native.isOwnerConversation("dingtalk", "fixture-room"), false);
    // Fresh allowing rules choose the recipient; the native display may still show the prior room.
    assert.equal((await native.liveOwnerChannel("dingtalk"))?.address.target, "replacement");
    const deliveryKey = randomBytes(32).toString("hex");
    await native.publish({
      type: "pet.task.reported",
      target: { channel: "dingtalk", target: "replacement" },
      text: "fixture notice",
      deliveryKey,
    });
    const poll = await fetch(control.baseUrl + "/v1/events?after=0&waitMs=0", {
      headers: { Authorization: "Bearer " + control.token },
    });
    assert.equal(poll.status, 200);
    const page = await poll.json();
    assert.ok(
      page.events.some((e: { deliveryKey: string }) => e.deliveryKey === deliveryKey) ||
        existsSync(deliveries),
    );
    await stop(true);
    child = start();
    await until(() => ready >= 2);
    assert.equal((await native.getDingTalkSetup()).secretStorage, "secure");
    assert.ok(!JSON.stringify(await native.status()).includes(input.clientSecret));
    assert.equal(JSON.parse(readFileSync(descriptorPath, "utf8")).pid, child.pid);
    assert.ok(await native.deliveryState(deliveryKey));
    await native.stop();
    await stop(true);
    child = start();
    await until(() => ready >= 3);
    assert.equal((await native.status()).running, false);
    assert.equal(foreignReads, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(file, "utf8")).credentials.find(
        (entry: { id: string }) => entry.id === other.id,
      ),
      other,
    );
    console.log(
      "PASS hosted IM process, keyring, live recipient, authenticated control and durable restart",
    );
  } finally {
    release?.();
    await stop();
  }
}
