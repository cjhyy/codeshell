import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { DeviceRelayStore, type RelaySecretCipher } from "./device-relay-store.js";
import { validateRelayEnrollment } from "./device-relay-enrollment.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(available = true) {
  const root = mkdtempSync(join(tmpdir(), "desktop-relay-store-"));
  roots.push(root);
  const key = randomBytes(32);
  const cipher: RelaySecretCipher = {
    available: () => available,
    encrypt(value) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([c.update(value), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), encrypted]);
    },
    decrypt(value) {
      const c = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString();
    },
  };
  const path = join(root, "relay.enc");
  const registration = {
    relayOrigin: "https://directory.example",
    publicOrigin: "https://computer.devices.example",
    hostId: randomUUID(),
    environmentId: randomUUID(),
    credential: randomBytes(32).toString("base64url"),
    credentialEpoch: 1,
    protocolVersion: 1 as const,
    name: "电脑",
  };
  return { root, path, registration, cipher, store: new DeviceRelayStore(path, cipher) };
}
test("separate registration persists only ciphertext and restores the exact credential", () => {
  const { path, registration, cipher, store } = setup();
  store.preflight();
  store.save(registration);
  expect(readFileSync(path).includes(Buffer.from(registration.credential))).toBe(false);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(new DeviceRelayStore(path, cipher).load()).toEqual(registration);
  store.forget();
  expect(store.load()).toBeUndefined();
});
test("unavailable secure storage cannot consume a ticket or save plaintext", () => {
  const { path, store, registration } = setup(false);
  expect(() => store.preflight()).toThrow("系统安全存储不可用");
  expect(() => store.save(registration)).toThrow();
  expect(() => statSync(path)).toThrow();
});
test("corrupt, oversized and symbolic-link registration fail closed", () => {
  const { root, path, store } = setup();
  writeFileSync(path, "not ciphertext");
  expect(() => store.load()).toThrow();
  writeFileSync(path, Buffer.alloc(20_000));
  expect(() => store.load()).toThrow();
  rmSync(path);
  writeFileSync(join(root, "target"), "secret");
  symlinkSync(join(root, "target"), path);
  expect(() => store.load()).toThrow();
  store.forget();
  expect(readFileSync(join(root, "target"), "utf8")).toBe("secret");
});
test("enrollment accepts only canonical HTTPS origins and bounded tickets/names", () => {
  const input = {
    relayOrigin: "https://directory.example",
    ticket: randomBytes(32).toString("base64url"),
    name: "电脑",
  };
  expect(() => validateRelayEnrollment(input)).not.toThrow();
  for (const relayOrigin of [
    "http://directory.example",
    "https://user:secret@directory.example",
    "https://directory.example/path",
    "https://directory.example?ticket=secret",
  ])
    expect(() => validateRelayEnrollment({ ...input, relayOrigin })).toThrow();
  expect(() => validateRelayEnrollment({ ...input, ticket: "short" })).toThrow();
  expect(() => validateRelayEnrollment({ ...input, name: "\ncomputer" })).toThrow();
});
