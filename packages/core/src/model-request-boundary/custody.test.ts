import { afterEach, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PlaintextCipher, type EncryptionCipher } from "../credentials/cipher.js";
import { ModelRequestKeyStore } from "./custody.js";
import { canonicalDigest, canonicalJson } from "./canonical.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const subject = {
  sessionId: "synthetic-session",
  storageScopeId: "a".repeat(64),
  sessionInstanceId: "11111111-1111-1111-1111-111111111111",
};
const input = {
  subject,
  prehashes: { messages: canonicalDigest([{ role: "user", content: "short private text" }]) },
};
function directory() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-request-key-"));
  roots.push(root);
  return join(root, "host-custody");
}
function encryptedCipher(): EncryptionCipher {
  const master = randomBytes(32);
  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master, iv);
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return "enc:fixture:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    },
    decrypt(value) {
      const data = Buffer.from(value.slice("enc:fixture:".length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", master, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

test("canonical JSON follows provider JSON semantics while preserving array order", () => {
  expect(canonicalJson({ z: undefined, b: 2, a: { z: 3, a: 1 } })).toBe(
    '{"a":{"a":1,"z":3},"b":2}',
  );
  expect(canonicalDigest(["a", "b"])).not.toBe(canonicalDigest(["b", "a"]));
});

test("explicit owner-only Host keys persist across instances, are private, and bind Session incarnation/scope", async () => {
  const folder = directory();
  const options = {
    directory: folder,
    cipher: new PlaintextCipher(),
    custodyMode: "owner-only-plaintext" as const,
  };
  const first = await new ModelRequestKeyStore(options).sign(input);
  expect(await new ModelRequestKeyStore(options).sign(input)).toEqual(first);
  expect(
    await new ModelRequestKeyStore(options).sign({
      ...input,
      subject: { ...subject, ephemeral: false },
    }),
  ).toEqual(first);
  const augmented = { ...subject, unrecognizedMetadata: "ignored, not a new incarnation" };
  expect(await new ModelRequestKeyStore(options).sign({ ...input, subject: augmented })).toEqual(
    first,
  );
  expect(first.custodyMode).toBe("owner-only-plaintext");
  expect(first.digests.messages).not.toBe(input.prehashes.messages);
  const anotherScope = await new ModelRequestKeyStore(options).sign({
    ...input,
    subject: { ...subject, storageScopeId: "b".repeat(64) },
  });
  const fork = await new ModelRequestKeyStore(options).sign({
    ...input,
    subject: { ...subject, sessionInstanceId: "22222222-2222-2222-2222-222222222222" },
  });
  expect(anotherScope.keyId).not.toBe(first.keyId);
  expect(fork.keyId).not.toBe(first.keyId);
  if (process.platform !== "win32") {
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(folder))
      expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
  }
  const raw = readdirSync(folder)
    .map((name) => readFileSync(join(folder, name), "utf8"))
    .join("");
  expect(raw).toContain('"custodyMode":"owner-only-plaintext"');
  expect(raw).not.toContain("short private text");
  expect(raw).not.toContain(subject.sessionId);
});

test("encrypted Host custody retains no plaintext key and HMAC domains cannot be substituted", async () => {
  const folder = directory(),
    cipher = encryptedCipher();
  const store = new ModelRequestKeyStore({
    directory: folder,
    cipher,
    custodyMode: "host-encrypted",
  });
  const signatures = await store.sign({
    ...input,
    prehashes: { system: input.prehashes.messages, messages: input.prehashes.messages },
  });
  expect(signatures.digests.system).not.toBe(signatures.digests.messages);
  const raw = readFileSync(join(folder, readdirSync(folder)[0]!), "utf8");
  expect(raw).not.toContain(cipher.decrypt(JSON.parse(raw).protectedKey));
  expect(JSON.stringify(signatures)).not.toContain("enc:fixture:");
  expect(
    await new ModelRequestKeyStore({
      directory: folder,
      cipher,
      custodyMode: "host-encrypted",
    }).sign({ ...input, prehashes: { messages: input.prehashes.messages } }),
  ).toMatchObject({ keyId: signatures.keyId, digests: { messages: signatures.digests.messages } });
});

test("custody failure and corrupt key never rotate or downgrade into a new apparent Session key", async () => {
  const folder = directory();
  const options = {
    directory: folder,
    cipher: new PlaintextCipher(),
    custodyMode: "owner-only-plaintext" as const,
  };
  await new ModelRequestKeyStore(options).sign(input);
  const file = join(folder, readdirSync(folder)[0]!);
  writeFileSync(file, "corrupt", { mode: 0o600 });
  await expect(new ModelRequestKeyStore(options).sign(input)).rejects.toThrow();
  expect(readFileSync(file, "utf8")).toBe("corrupt");
  await expect(
    new ModelRequestKeyStore({
      directory: directory(),
      cipher: new PlaintextCipher(),
      custodyMode: "host-encrypted",
    }).sign(input),
  ).rejects.toThrow("requires encryption");
});

test("ephemeral keys never create custody files and are destroyed with the Host lifetime", async () => {
  const folder = directory();
  const store = new ModelRequestKeyStore({
    directory: folder,
    cipher: new PlaintextCipher(),
    custodyMode: "owner-only-plaintext",
  });
  const ephemeral = { ...input, subject: { ...subject, ephemeral: true } };
  const first = await store.sign(ephemeral);
  expect(first.custodyMode).toBe("ephemeral-memory");
  expect(await store.sign(ephemeral)).toEqual(first);
  expect(existsSync(folder)).toBe(false);
  store.dispose();
  const replacement = await store.sign(ephemeral);
  expect(replacement.keyId).not.toBe(first.keyId);
  expect(existsSync(folder)).toBe(false);
});

test("restart and concurrent independent Host processes retain exactly one durable Session key", async () => {
  const folder = directory();
  const moduleUrl = new URL("./custody.ts", import.meta.url).href;
  const cipherUrl = new URL("../credentials/cipher.ts", import.meta.url).href;
  const program = `import {ModelRequestKeyStore} from ${JSON.stringify(moduleUrl)}; import {PlaintextCipher} from ${JSON.stringify(cipherUrl)}; const store = new ModelRequestKeyStore({directory:process.env.PROOF_DIRECTORY,cipher:new PlaintextCipher(),custodyMode:"owner-only-plaintext"}); console.log(JSON.stringify(await store.sign(JSON.parse(process.env.PROOF_INPUT))));`;
  const launch = async () => {
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: {
        ...process.env,
        HOME: folder,
        USERPROFILE: folder,
        PROOF_DIRECTORY: folder,
        PROOF_INPUT: JSON.stringify(input),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(result);
  };
  const results = await Promise.all(Array.from({ length: 4 }, launch));
  expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
    true,
  );
  expect(await launch()).toEqual(results[0]);
  expect(readdirSync(folder)).toHaveLength(1);
});
