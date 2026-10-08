import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PlaintextCipher, Methods, type EncryptionCipher } from "@cjhyy/code-shell-core";
import { createDesktopModelRequestSigner } from "./model-request-signing-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-desktop-signing-"));
  roots.push(root);
  const sessions = join(root, "sessions");
  const subject = {
    sessionId: "synthetic-session",
    sessionInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storageScopeId: createHash("sha256").update(sessions).digest("hex"),
  };
  mkdirSync(join(sessions, subject.sessionId), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(sessions, subject.sessionId, "state.json"),
    JSON.stringify({
      sessionId: subject.sessionId,
      costState: {
        accountingSessionId: subject.sessionInstanceId,
        sessionScopeId: subject.storageScopeId,
      },
    }),
    { mode: 0o600 },
  );
  return { root, sessions, subject, input: { subject, prehashes: { messages: "a".repeat(64) } } };
}
function cipher(): EncryptionCipher {
  const master = randomBytes(32);
  return {
    encrypt(value) {
      const iv = randomBytes(12),
        encrypt = createCipheriv("aes-256-gcm", master, iv);
      const body = Buffer.concat([encrypt.update(value), encrypt.final()]);
      return `enc:fixture:${Buffer.concat([iv, encrypt.getAuthTag(), body]).toString("base64")}`;
    },
    decrypt(value) {
      const body = Buffer.from(value.slice("enc:fixture:".length), "base64"),
        decrypt = createDecipheriv("aes-256-gcm", master, body.subarray(0, 12));
      decrypt.setAuthTag(body.subarray(12, 28));
      return Buffer.concat([decrypt.update(body.subarray(28)), decrypt.final()]).toString();
    },
  };
}

test("Desktop durable signing requires available encryption and matching persisted Session ownership", async () => {
  const { root, sessions, input } = fixture();
  const encryption = cipher();
  let available = false;
  const options = {
    hostDirectory: join(root, "host"),
    sessionStorageDir: sessions,
    cipher: encryption,
    encryptionAvailable: () => available,
    hasActiveEphemeralOwner: () => false,
  };
  const service = createDesktopModelRequestSigner(options);
  await expect(service.sign(input)).rejects.toThrow("encryption unavailable");
  expect(existsSync(options.hostDirectory)).toBe(false);
  available = true;
  const first = await service.sign(input);
  expect(first.custodyMode).toBe("host-encrypted");
  expect(await createDesktopModelRequestSigner(options).sign(input)).toEqual(first);
  await expect(
    service.sign({
      ...input,
      subject: { ...input.subject, sessionInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    }),
  ).rejects.toThrow("incarnation mismatch");
  await expect(
    service.sign({ ...input, subject: { ...input.subject, storageScopeId: "0".repeat(64) } }),
  ).rejects.toThrow("owner mismatch");
  const directory = join(options.hostDirectory, "request-keys", "host-encrypted");
  expect(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8")).toContain(
    "enc:fixture:",
  );
  expect(JSON.stringify(first)).not.toContain("enc:fixture:");
  expect(Object.values(Methods)).not.toContain("desktop/modelRequestSign");
});

test("Desktop never silently accepts plaintext as encrypted request custody", async () => {
  const { root, sessions, input } = fixture();
  const service = createDesktopModelRequestSigner({
    hostDirectory: join(root, "host"),
    sessionStorageDir: sessions,
    cipher: new PlaintextCipher(),
    encryptionAvailable: () => true,
    hasActiveEphemeralOwner: () => false,
  });
  await expect(service.sign(input)).rejects.toThrow("requires encryption");
});

test("ephemeral signing is pinned to native ownership and the worker generation", async () => {
  const { root, sessions, input } = fixture();
  let active = false;
  const options = {
    hostDirectory: join(root, "host"),
    sessionStorageDir: sessions,
    cipher: cipher(),
    encryptionAvailable: () => false,
    hasActiveEphemeralOwner: (id: string) => active && id === "qchat-native-owner",
  };
  const service = createDesktopModelRequestSigner(options);
  const ephemeral = {
    ...input,
    subject: { ...input.subject, sessionId: "qchat-native-owner", ephemeral: true },
  };
  await expect(service.sign(ephemeral)).rejects.toThrow("no longer active");
  active = true;
  const second = {
    ...ephemeral,
    subject: { ...ephemeral.subject, sessionInstanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  };
  const concurrent = await Promise.allSettled([service.sign(ephemeral), service.sign(second)]);
  expect(concurrent.map((entry) => entry.status)).toEqual(["fulfilled", "rejected"]);
  const first = await service.sign(ephemeral);
  expect(first.custodyMode).toBe("ephemeral-memory");
  expect(existsSync(options.hostDirectory)).toBe(false);
  active = false;
  await expect(service.sign(ephemeral)).rejects.toThrow("no longer active");
  service.dispose?.();
  active = true;
  expect((await service.sign(second)).keyId).not.toBe(first.keyId);
  expect(existsSync(options.hostDirectory)).toBe(false);
});
