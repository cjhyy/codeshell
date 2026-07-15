import { test, expect } from "bun:test";
import { parsePairingToken } from "./pairing";

test("从 URL search 取出 pairing token", () => {
  expect(parsePairingToken("?pairing=abc123")).toBe("abc123");
  expect(parsePairingToken("?foo=1&pairing=xyz")).toBe("xyz");
  expect(parsePairingToken("?foo=1")).toBeNull();
  expect(parsePairingToken("")).toBeNull();
});
