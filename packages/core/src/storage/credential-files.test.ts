import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFileCommand, type CredentialFileSnapshot } from "./credential-files.js";

test("pending retirement count is a fixed user-only projection over opaque legacy records", () => {
  const root = mkdtempSync(join(tmpdir(), "link-retirement-count-"));
  try {
    const user = join(root, "user");
    const count = (payload: unknown = {}, permit?: Int32Array) =>
      credentialFileCommand(user, "credentials/pendingRetirements", payload, permit);
    expect(count()).toBe(0);
    expect(existsSync(user)).toBe(false);
    mkdirSync(user);
    const path = join(user, "credentials.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        credentials: [
          { type: "oauth", secret: "enc:fixture-token" },
          { type: "remote-link-retirement", secret: "enc:opaque" },
          { type: "remote-link-retirement", version: 2, unknown: true },
        ],
      }),
    );
    const before = readFileSync(path);
    expect(count()).toBe(2);
    expect(readFileSync(path)).toEqual(before);
    expect(() => count({ scope: "project", cwd: root })).toThrow(/Invalid/);
    expect(() => count({ scope: "user" })).toThrow(/Invalid/);
    expect(() => count({}, new Int32Array(new SharedArrayBuffer(4)).fill(-1))).toThrow(/revoked/);
    writeFileSync(path, "invalid");
    expect(() => count()).toThrow(/Invalid credential store/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("user and project alias the same credential directory without taking its lock twice", () => {
  const root = mkdtempSync(join(tmpdir(), "link-aliased-credential-"));
  try {
    const user = join(root, ".code-shell");
    const before = credentialFileCommand(user, "credentials/read", {
      scope: "user",
    }) as CredentialFileSnapshot;
    const file = {
      version: 1,
      credentials: [{ type: "token", id: "fixture", label: "fixture", secret: "enc:fixture" }],
    };
    expect(
      credentialFileCommand(user, "credentials/commit", {
        scope: "user",
        expectedRevision: before.revision,
        file,
        projectGuard: { cwd: root, revision: before.revision },
      }),
    ).toBe(true);
    expect(
      (credentialFileCommand(user, "credentials/read", { scope: "user" }) as CredentialFileSnapshot)
        .file,
    ).toEqual(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
