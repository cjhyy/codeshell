import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { channel } from "node:diagnostics_channel";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionState } from "../types.js";
import { writeStateAtomically } from "./session-state-file.js";

for (const [platformName, codes, successful, attempts] of [
  ["win32", ["EPERM", "EBUSY", "EACCES"], true, 4],
  ["win32", ["ENOSPC"], false, 1],
  ["win32", ["EACCES"], false, "until deadline"],
  ["darwin", ["EPERM"], false, 1],
] as const) {
  test(`atomic Session state replacement on ${platformName} with ${codes.join(", ")}`, () => {
    const root = fs.mkdtempSync(join(tmpdir(), "session-state-replace-"));
    const target = join(root, "state.json");
    fs.writeFileSync(target, "original");
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const rename = fs.renameSync;
    const sources: fs.PathLike[] = [];
    const changed = channel("codeshell.session.state-committed");
    const notifications: unknown[] = [];
    const observe = (value: unknown) => notifications.push(value);
    changed.subscribe(observe);
    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      expect(destination).toBe(target);
      expect(fs.readFileSync(target, "utf8")).toBe("original");
      sources.push(source);
      const code = attempts === "until deadline" ? codes[0] : codes[sources.length - 1];
      if (code) throw Object.assign(new Error(code), { code });
      rename(source, destination);
    });
    try {
      Object.defineProperty(process, "platform", { ...platform, value: platformName });
      const update = () => writeStateAtomically(target, { sessionId: "test" } as SessionState);
      if (successful) {
        update();
        expect(JSON.parse(fs.readFileSync(target, "utf8")).sessionId).toBe("test");
      } else {
        expect(update).toThrow(codes[0]);
        expect(fs.readFileSync(target, "utf8")).toBe("original");
      }
      if (attempts === "until deadline") expect(sources.length).toBeGreaterThan(1);
      else expect(sources).toHaveLength(attempts);
      expect(new Set(sources).size).toBe(1);
      expect(notifications).toHaveLength(successful ? 1 : 0);
      expect(fs.readdirSync(root)).toEqual(["state.json"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
      changed.unsubscribe(observe);
      spy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
