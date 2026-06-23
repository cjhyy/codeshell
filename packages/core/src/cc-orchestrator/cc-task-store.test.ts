import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CCTaskStore } from "./cc-task-store.js";

describe("CCTaskStore", () => {
  it("round-trips CC task meta by jobId", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-task-")), "cc-tasks.json");
    const store = new CCTaskStore(file);
    store.set("job1", { kind: "loop", goal: "ship it", continuation: "auto", sessionId: undefined });
    const got = store.get("job1");
    expect(got?.kind).toBe("loop");
    expect(got?.continuation).toBe("auto");
    expect(new CCTaskStore(file).get("job1")?.goal).toBe("ship it");
  });
  it("updates sessionId (judge picked fresh / run回写)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-task-")), "cc-tasks.json");
    const store = new CCTaskStore(file);
    store.set("j", { kind: "once", continuation: "always-fresh" });
    store.patch("j", { sessionId: "S5" });
    expect(store.get("j")?.sessionId).toBe("S5");
  });
});
