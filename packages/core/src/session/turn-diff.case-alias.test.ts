import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { TurnDiffTracker } from "./turn-diff";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(process.env.HOME!, "turn-diff-case-owned-")));
  roots.push(cwd);
  const upper = join(cwd, "A.ts"),
    lower = join(cwd, "a.ts");
  const probe = join(cwd, "Probe");
  writeFileSync(probe, "owned case probe\n", { mode: 0o600 });
  const alias = join(cwd, "probe");
  const insensitive =
    existsSync(alias) &&
    lstatSync(probe).dev === lstatSync(alias).dev &&
    lstatSync(probe).ino === lstatSync(alias).ino;
  console.log(JSON.stringify({ boundary: "owned regular filesystem case probe", insensitive }));
  return {
    cwd,
    upper,
    lower,
    insensitive,
    tracker: new TurnDiffTracker({ cwd, turnId: "owned-turn" }),
  };
}

test("two spellings of one existing physical file retain one original-to-latest diff", () => {
  const { upper, lower, insensitive, tracker } = fixture();
  writeFileSync(upper, "original\n");
  if (!insensitive) writeFileSync(lower, "separate original\n");
  if (insensitive) {
    expect(lstatSync(upper).dev).toBe(lstatSync(lower).dev);
    expect(lstatSync(upper).ino).toBe(lstatSync(lower).ino);
  } else expect(lstatSync(upper).ino).not.toBe(lstatSync(lower).ino);
  tracker.begin("first", [upper]);
  writeFileSync(upper, "middle\n");
  tracker.end("first", true);
  tracker.begin("second", [lower]);
  writeFileSync(lower, "final\n");
  const result = tracker.end("second", true)!;
  tracker.refresh();
  const latest = tracker.current()!;
  expect(result.complete).toBe(true);
  expect(latest.files).toHaveLength(insensitive ? 1 : 2);
  expect(latest.trackedPaths).toHaveLength(insensitive ? 1 : 2);
  if (insensitive) {
    expect(latest.files[0]!.path).toBe(realpathSync.native(upper));
    expect(latest.files[0]!.diff).toContain("-original\n+final\n");
    expect(latest.files[0]!.diff).not.toContain("middle");
  } else {
    expect(latest.files.find((f) => f.path === upper)!.diff).toContain("-original\n+middle\n");
    expect(latest.files.find((f) => f.path === lower)!.diff).toContain(
      "-separate original\n+final\n",
    );
  }
});

test("an absent target acquires its actual spelling after its first successful receipt", () => {
  const { upper, lower, insensitive, tracker } = fixture();
  tracker.begin("create", [lower]);
  const created = insensitive ? upper : lower;
  writeFileSync(created, "created\n");
  const first = tracker.end("create", true)!;
  expect(first.files).toHaveLength(1);
  expect(first.files[0]!.path).toBe(realpathSync.native(created));
  tracker.begin("later", [created]);
  writeFileSync(created, "final\n");
  const result = tracker.end("later", true)!;
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.status).toBe("added");
  expect(result.files[0]!.diff).toContain("+final\n");
  expect(result.files[0]!.diff).not.toContain("created");
});

test("interleaved absent aliases keep the earliest absent baseline and both pending receipts", () => {
  const { upper, lower, insensitive, tracker } = fixture();
  tracker.begin("first", [upper]);
  tracker.begin("second", [lower]);
  writeFileSync(upper, "first\n");
  tracker.end("first", true);
  writeFileSync(lower, "latest\n");
  const result = tracker.end("second", true)!;
  expect(result.files).toHaveLength(insensitive ? 1 : 2);
  expect(result.toolCallIds).toEqual(["first", "second"]);
  expect(result.files.every((f) => f.status === "added")).toBe(true);
  if (insensitive) expect(result.files[0]!.diff).toContain("+latest\n");
  else expect(result.files.map((f) => f.path).sort()).toEqual([upper, lower].sort());
});

test("a later spelling cannot replace an earlier baseline when creation is still pending", () => {
  const { upper, lower, insensitive, tracker } = fixture();
  tracker.begin("first", [lower]);
  writeFileSync(upper, "first\n");
  tracker.begin("second", [upper]);
  writeFileSync(upper, "latest\n");
  tracker.end("second", true);
  // On sensitive filesystems the first target remains absent; this is a
  // separate physical-path control, not a claimed alias.
  const result = tracker.end("first", insensitive)!;
  const latest = result ?? tracker.current()!;
  expect(latest.files).toHaveLength(1);
  expect(latest.files[0]!.path).toBe(realpathSync.native(upper));
  expect(latest.files[0]!.status).toBe(insensitive ? "added" : "modified");
  expect(latest.files[0]!.diff).toContain("+latest\n");
  if (insensitive) expect(latest.files[0]!.diff).not.toContain("-first\n");
});

test("regular-file case normalization does not turn a symlink leaf into target authority", () => {
  const { cwd, upper, tracker } = fixture();
  writeFileSync(upper, "private\n");
  if (process.platform === "win32") {
    // Link creation needs an OS privilege. This is a regular-file control,
    // not evidence for Windows symlink handling; the original POSIX test stays.
    console.log("Windows regular-file control; no symlink privilege requested");
    tracker.begin("regular", [upper]);
    const result = tracker.end("regular", true)!;
    expect(result.complete).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.trackedPaths).toEqual([realpathSync.native(upper)]);
    return;
  }
  const link = join(cwd, "alias.ts");
  symlinkSync(upper, link);
  tracker.begin("symlink", [link]);
  const result = tracker.end("symlink", true)!;
  expect(result.complete).toBe(false);
  expect(result.files).toEqual([]);
  expect(result.trackedPaths).toEqual([link]);
  expect(result.omissions[0]!.reason).toBe("not a regular file");
  expect(readFileSync(upper, "utf8")).toBe("private\n");
});

test("a resumed pending creation keeps its absent baseline after leaf spelling becomes known", () => {
  const { cwd, upper, lower, insensitive } = fixture();
  const sessionDir = join(cwd, "session");
  const first = new TurnDiffTracker({ cwd, turnId: "resume", sessionDir });
  first.begin("interrupted", [lower]);
  const created = insensitive ? upper : lower;
  writeFileSync(created, "before resume\n");
  const resumed = new TurnDiffTracker({ cwd, turnId: "resume", sessionDir });
  resumed.begin("next", [created]);
  writeFileSync(created, "after resume\n");
  const result = resumed.end("next", true)!;
  expect(result.complete).toBe(true);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]!.path).toBe(realpathSync.native(created));
  expect(result.files[0]!.status).toBe("added");
  expect(result.files[0]!.diff).toContain("+after resume\n");
  expect(result.files[0]!.diff).not.toContain("-before resume\n");
  expect(result.toolCallIds).toEqual(["interrupted", "next"]);
});
