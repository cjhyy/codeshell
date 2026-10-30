import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBatch, INSPECTION_BATCH_SIZE } from "./inspection-batch.js";
import { previewLocalPanelApp } from "./installer.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "panel-inspection-batch-")));
  roots.push(root);
  const files = new Map<string, Buffer>([
    [
      ".codeshell-panel/panel.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          id: "inspection-batch",
          version: "1.0.0",
          title: { default: "Inspection batch" },
          entry: "app/index.html",
          permissions: [],
        }),
      ),
    ],
    ["app/index.html", Buffer.from("<!doctype html><title>Fixture</title>")],
    ...Array.from({ length: 13 }, (_, index): [string, Buffer] => [
      `app/${String(index).padStart(2, "0")}.js`,
      Buffer.alloc(1024 + index * 7, index),
    ]),
  ]);
  await fs.mkdir(join(root, ".codeshell-panel"));
  await fs.mkdir(join(root, "app"));
  for (const [name, bytes] of files) await fs.writeFile(join(root, name), bytes);
  const expected = () => {
    const hash = createHash("sha256");
    for (const name of [...files.keys()].sort())
      hash.update(name).update("\0").update(files.get(name)!);
    return hash.digest("hex");
  };
  return { root, files, expected };
}

test("full multi-batch review keeps the serial digest and rereads changed bytes", async () => {
  const f = await fixture();
  const first = await previewLocalPanelApp({ kind: "dir", path: f.root });
  expect(first.reviewToken).toBe(f.expected());
  const changed = "app/12.js";
  const bytes = Buffer.alloc(f.files.get(changed)!.length, 97);
  f.files.set(changed, bytes);
  await fs.writeFile(join(f.root, changed), bytes);
  const next = await previewLocalPanelApp({ kind: "dir", path: f.root });
  expect(next.reviewToken).toBe(f.expected());
  expect(next.reviewToken).not.toBe(first.reviewToken);
});

test("full inspection bounds active file descriptors and closes every read", async () => {
  const f = await fixture();
  const originalOpen = fs.open;
  let active = 0;
  let maximum = 0;
  const open = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    active++;
    maximum = Math.max(maximum, active);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await originalClose();
      } finally {
        active--;
      }
    };
    return handle;
  });
  try {
    expect((await previewLocalPanelApp({ kind: "dir", path: f.root })).reviewToken).toBe(
      f.expected(),
    );
    expect(maximum).toBe(INSPECTION_BATCH_SIZE);
    expect(active).toBe(0);
  } finally {
    open.mockRestore();
  }
});

test.each(["grow", "truncate", "rewrite"])(
  "inspection rejects a file that will %s after its descriptor size check",
  async (change) => {
    const f = await fixture();
    const target = join(f.root, "app/12.js");
    const originalOpen = fs.open;
    let changed = false;
    let active = 0;
    const open = spyOn(fs, "open").mockImplementation(
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        active++;
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          try {
            return await originalClose();
          } finally {
            active--;
          }
        };
        if (args[0] === target) {
          const originalStat = handle.stat.bind(handle);
          handle.stat = (async () => {
            const before = await originalStat();
            if (!changed) {
              changed = true;
              const size =
                change === "grow" ? before.size + 65536 : change === "truncate" ? 1 : before.size;
              await fs.writeFile(target, Buffer.alloc(size, 99));
              await fs.utimes(
                target,
                new Date(before.mtimeMs + 1000),
                new Date(before.mtimeMs + 1000),
              );
            }
            return before;
          }) as typeof handle.stat;
        }
        return handle;
      },
    );
    try {
      await expect(previewLocalPanelApp({ kind: "dir", path: f.root })).rejects.toThrow(
        "changed while reading",
      );
      expect(changed).toBe(true);
      expect(active).toBe(0);
    } finally {
      open.mockRestore();
    }
  },
);

test.each(["async", "sync"])(
  "a %s batch failure drains sibling reads before rejecting",
  async (kind) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished: number[] = [];
    let rejected = false;
    const failure = new Error("fixture rejected");
    const result = inspectBatch([0, 1, 2, 3], (index) => {
      if (index === 0) {
        if (kind === "sync") throw failure;
        return Promise.reject(failure);
      }
      return held.then(() => {
        finished.push(index);
        return index;
      });
    }).catch((error) => {
      rejected = true;
      return error;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected).toBe(false);
    release();
    expect(await result).toBe(failure);
    expect(finished).toEqual([1, 2, 3]);
  },
);
