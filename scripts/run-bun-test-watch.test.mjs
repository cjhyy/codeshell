import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFiles, runBunTestWatch } from "./run-bun-test-watch.mjs";

test("watch rejects broad discovery and uses isolated credentials and explicit paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
  let home;
  try {
    writeFileSync(join(dir, "one.test.ts"), "");
    for (const args of [[], ["."], ["one"], ["--watch"], Array(9).fill("one.test.ts")])
      assert.throws(() => watchFiles(args, dir));
    assert.deepEqual(watchFiles(["one.test.ts"], dir), ["./one.test.ts"]);
    await runBunTestWatch(["one.test.ts"], {
      cwd: dir,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: "secret", CUSTOM_TOKEN: "secret" },
      spawn(command, args, options) {
        assert.equal(command, "bun");
        assert.deepEqual(args, ["test", "--timeout", "30000", "--watch", "./one.test.ts"]);
        home = options.env.HOME;
        assert.ok(home && home !== process.env.HOME);
        assert.equal(options.env.OPENAI_API_KEY, undefined);
        assert.equal(options.env.CUSTOM_TOKEN, undefined);
        assert.ok(existsSync(home));
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing watch process rejects after removing its temporary home", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-failure-"));
  let home;
  try {
    writeFileSync(join(dir, "one.test.ts"), "");
    await assert.rejects(
      runBunTestWatch(["one.test.ts"], {
        cwd: dir,
        spawn(_command, _args, options) {
          home = options.env.HOME;
          const child = new EventEmitter();
          child.kill = () => {};
          queueMicrotask(() => child.emit("close", 2, null));
          return child;
        },
      }),
      /failed/,
    );
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
