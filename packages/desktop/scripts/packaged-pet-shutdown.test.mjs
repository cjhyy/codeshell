import { test, expect } from "bun:test";
import { settlePackagedPet } from "./packaged-pet-shutdown.mjs";

const defaults = () => ({
  failures: [],
  closeApp: async () => {},
  closeModel: async () => {},
  verifyUnchanged: async () => ({ unchangedAfterRuntime: true }),
  readNativeCalls: async () => [],
  canCleanup: async () => true,
  cleanup: async () => {},
  retainedHome: "/private-owned-fixture/home",
});

test("primary timeout and failed close remain failures while unconfirmed children retain HOME", async () => {
  let removed = false;
  let verified = false;
  const primary = Error("Pet timed out");
  const close = Error("owned child did not close");
  const result = await settlePackagedPet({
    ...defaults(),
    failures: [primary],
    closeApp: async () => {
      throw close;
    },
    verifyUnchanged: async () => {
      verified = true;
      return { unchangedAfterRuntime: true };
    },
    canCleanup: async () => false,
    cleanup: async () => {
      removed = true;
    },
  });
  expect(result.errors[0]).toBe(primary);
  expect(result.errors[1]).toBe(close);
  expect(result.errors[2].message).toContain("HOME retained");
  expect(verified).toBe(true);
  expect(removed).toBe(false);
  expect(result.privateHomeRemoved).toBe(false);
});

test("corrupt exit proof does not replace the primary error or permit cleanup", async () => {
  const primary = Error("primary assertion");
  const malformed = Error("invalid worker exit JSON");
  const result = await settlePackagedPet({
    ...defaults(),
    failures: [primary],
    canCleanup: async () => {
      throw malformed;
    },
    cleanup: async () => {
      throw Error("must not remove");
    },
  });
  expect(result.errors.slice(0, 2)).toEqual([primary, malformed]);
  expect(result.errors).toHaveLength(3);
  expect(result.artifacts.unchangedAfterRuntime).toBe(true);
  expect(result.privateHomeRemoved).toBe(false);
});

test("verified exits still report cleanup failure alongside the primary assertion", async () => {
  const primary = Error("primary assertion");
  const remove = Error("owned HOME removal failed");
  const result = await settlePackagedPet({
    ...defaults(),
    failures: [primary],
    cleanup: async () => {
      throw remove;
    },
  });
  expect(result.errors).toEqual([primary, remove]);
  expect(result.privateHomeRemoved).toBe(false);
});
