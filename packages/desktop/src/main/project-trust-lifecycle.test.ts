import { expect, test } from "bun:test";
import { setProjectTrustWithRevocation } from "./project-trust-lifecycle.js";

test("a failed trust write still fences existing execution and reports the persistence failure", async () => {
  const calls: string[] = [];
  await expect(
    setProjectTrustWithRevocation("/test/project", "untrusted", {
      setTrust: async () => {
        calls.push("write");
        throw new Error("disk unavailable");
      },
      revokeExternalRuntimeTrust: async () => {
        calls.push("cancel");
      },
    }),
  ).rejects.toThrow(/disk unavailable/);
  expect(calls).toEqual(["write", "cancel"]);
});

test("cancellation failure is observable after a successful trust write", async () => {
  let persisted = false;
  await expect(
    setProjectTrustWithRevocation("/test/project", "untrusted", {
      setTrust: async () => {
        persisted = true;
      },
      revokeExternalRuntimeTrust: async () => {
        expect(persisted).toBe(true);
        throw new Error("provider could not stop");
      },
    }),
  ).rejects.toThrow(/provider could not stop/);
  expect(persisted).toBe(true);
});

test("granting trust does not stop another already-authorized runtime", async () => {
  let cancelled = false;
  await setProjectTrustWithRevocation("/test/project", "trusted", {
    setTrust: async () => {},
    revokeExternalRuntimeTrust: async () => {
      cancelled = true;
    },
  });
  expect(cancelled).toBe(false);
});
