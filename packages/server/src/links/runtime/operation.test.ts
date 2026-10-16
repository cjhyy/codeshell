import { describe, expect, test } from "bun:test";
import { executeLinkOperation } from "./operation.js";

describe("operation runtime boundaries", () => {
  test("never invokes getters or toJSON while taking an execution snapshot", async () => {
    let calls = 0;
    let serializations = 0;
    const input = Object.assign(
      Object.create({
        toJSON() {
          serializations++;
          return { owner: serializations === 1 ? "allowed" : "outside", repo: "b" };
        },
      }),
      { owner: "allowed", repo: "b" },
    );
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_repository",
        params: input,
        execute: async () => {
          calls++;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const getter = {
      repo: "b",
      get owner() {
        serializations++;
        return "allowed";
      },
    };
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_repository",
        params: getter,
        execute: async () => {
          calls++;
          return {};
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect({ calls, serializations }).toEqual({ calls: 0, serializations: 0 });
  });
  test("rejects an unsupported contract or invalid input without dispatch", async () => {
    let calls = 0;
    const execute = async () => {
      calls++;
      return {};
    };
    await expect(
      executeLinkOperation({ providerId: "figma", action: "invented", params: {}, execute }),
    ).rejects.toMatchObject({ code: "unsupported_contract" });
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_repository",
        params: { owner: "a" },
        execute,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toBe(0);
  });
  test("detaches inputs and rechecks authority before publishing results", async () => {
    const params = { owner: "a", repo: "b" };
    let checks = 0;
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_repository",
        params,
        assertAuthorized() {
          if (++checks === 2) throw new Error("revoked");
        },
        execute: async (input) => {
          params.repo = "changed";
          expect(input.repo).toBe("b");
          return {};
        },
      }),
    ).rejects.toThrow("revoked");
    expect(checks).toBe(2);
  });
  test("late cancellation and malformed responses cannot be published", async () => {
    const controller = new AbortController();
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_starred",
        params: { owner: "a", repo: "b" },
        signal: controller.signal,
        execute: async () => {
          controller.abort();
          return { starred: true };
        },
      }),
    ).rejects.toThrow();
    await expect(
      executeLinkOperation({
        providerId: "github",
        action: "get_starred",
        params: { owner: "a", repo: "b" },
        execute: async () => ({ starred: "yes" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_result" });
  });
});
