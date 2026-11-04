import { test, expect } from "bun:test";
import { probeProfileTools } from "./profile-tool-probe.js";

test("tool probes leave the event loop responsive and classify missing executables", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const results = await probeProfileTools([
      "node",
      "codeshell-no-such-fixture-bin",
      "../unsafe",
      "node",
    ]);
    expect(results.size).toBe(3);
    expect(results.get("node")).toMatchObject({ status: "ok" });
    expect(results.get("codeshell-no-such-fixture-bin")).toEqual({ status: "not-found" });
    expect(results.get("../unsafe")).toEqual({ status: "failed" });
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
  }
});
